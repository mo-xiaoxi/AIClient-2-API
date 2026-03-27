/**
 * copilot-core.js
 *
 * GitHub Copilot provider service. Implements ApiServiceAdapter interface.
 *
 * Authentication flow:
 *   1. GitHub OAuth Device Flow → long-lived access_token (stored in file)
 *   2. POST /copilot_internal/v2/token → short-lived Copilot JWT (25min TTL)
 *   3. All API requests use the Copilot JWT as Bearer token
 *
 * Supports:
 *   - /chat/completions  (standard models)
 *   - /models            (dynamic model discovery with static fallback)
 *   - Vision requests    (auto Copilot-Vision-Request header)
 *   - X-Initiator header (user vs agent based on last message role)
 */

import { randomUUID } from 'node:crypto';
import logger from '../../utils/logger.js';
import { CopilotTokenStore } from './copilot-token-store.js';

// ============================================================================
// Constants
// ============================================================================

const COPILOT_CHAT_PATH = '/chat/completions';
const COPILOT_MODELS_PATH = '/models';

// Copilot request headers
const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.35.0';
const COPILOT_EDITOR_VERSION = 'vscode/1.107.0';
const COPILOT_PLUGIN_VERSION = 'copilot-chat/0.35.0';
const COPILOT_INTEGRATION_ID = 'vscode-chat';
const COPILOT_OPENAI_INTENT = 'conversation-panel';
const COPILOT_GITHUB_API_VERSION = '2025-04-01';

// Model cache TTL: 5 minutes
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const FALLBACK_MODELS = [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'o4-mini', name: 'o4-mini' },
    { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
];

// ============================================================================
// CopilotApiService
// ============================================================================

export class CopilotApiService {
    constructor(config) {
        this.config = config;
        this.credFilePath = config.COPILOT_OAUTH_CREDS_FILE_PATH;
        this._tokenStore = null;
        this.isInitialized = false;
        this._cachedModels = null;
        this._modelsCachedAt = 0;
    }

    // ---------- Lifecycle ----------

    async initialize() {
        if (this.isInitialized) return;

        if (!this.credFilePath) {
            throw new Error('[CopilotApiService] COPILOT_OAUTH_CREDS_FILE_PATH is not configured.');
        }

        const store = new CopilotTokenStore(this.credFilePath);
        await store.initialize();
        this._tokenStore = store;
        this.isInitialized = true;
        logger.info('[CopilotApiService] Initialized successfully.');
    }

    // ---------- ApiServiceAdapter interface ----------

    /**
     * Non-streaming generation. Returns OpenAI Chat Completion format.
     * @param {string} model
     * @param {object} requestBody - OpenAI-format request body
     * @returns {Promise<object>}
     */
    async generateContent(model, requestBody) {
        await this._ensureInitialized();
        const { token, apiEndpoint } = await this._tokenStore.getValidCopilotJwt();
        const url = apiEndpoint + COPILOT_CHAT_PATH;

        const body = { ...requestBody, model, stream: false };
        const headers = this._buildHeaders(token, body);

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (err) {
            throw new Error(`[CopilotApiService] Network error: ${err.message}`);
        }

        const responseText = await resp.text();

        if (!resp.ok) {
            const err = new Error(`Copilot API error (${resp.status}): ${responseText}`);
            err.status = resp.status;
            if (resp.status === 401 || resp.status === 403) {
                this._tokenStore.invalidateJwt();
            }
            throw err;
        }

        try {
            return JSON.parse(responseText);
        } catch {
            throw new Error(`[CopilotApiService] Failed to parse response JSON: ${responseText}`);
        }
    }

    /**
     * Streaming generation. Yields OpenAI SSE-compatible chunk objects.
     * @param {string} model
     * @param {object} requestBody - OpenAI-format request body
     * @returns {AsyncGenerator<object>}
     */
    async *generateContentStream(model, requestBody) {
        await this._ensureInitialized();
        const { token, apiEndpoint } = await this._tokenStore.getValidCopilotJwt();
        const url = apiEndpoint + COPILOT_CHAT_PATH;

        const body = {
            ...requestBody,
            model,
            stream: true,
            stream_options: { include_usage: true },
        };
        const headers = this._buildHeaders(token, body);

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (err) {
            throw new Error(`[CopilotApiService] Network error: ${err.message}`);
        }

        if (!resp.ok) {
            const errText = await resp.text();
            const err = new Error(`Copilot API error (${resp.status}): ${errText}`);
            err.status = resp.status;
            if (resp.status === 401 || resp.status === 403) {
                this._tokenStore.invalidateJwt();
            }
            throw err;
        }

        // Parse SSE stream
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete last line

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;

                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') return;

                    try {
                        yield JSON.parse(data);
                    } catch {
                        logger.warn(`[CopilotApiService] Failed to parse SSE chunk: ${data}`);
                    }
                }
            }

            // Process any remaining buffer content
            if (buffer.trim().startsWith('data:')) {
                const data = buffer.trim().slice(5).trim();
                if (data && data !== '[DONE]') {
                    try {
                        yield JSON.parse(data);
                    } catch {
                        // silently ignore
                    }
                }
            }
        } finally {
            reader.cancel().catch(() => {});
        }
    }

    /**
     * List available models. Returns OpenAI-format model list.
     * Fetches dynamically from /models, falls back to static list.
     * @returns {Promise<object>}
     */
    async listModels() {
        // Return cached if still fresh
        if (this._cachedModels && (Date.now() - this._modelsCachedAt) < MODEL_CACHE_TTL_MS) {
            return this._cachedModels;
        }

        try {
            await this._ensureInitialized();
            const { token, apiEndpoint } = await this._tokenStore.getValidCopilotJwt();
            const models = await this._fetchModels(token, apiEndpoint);

            this._cachedModels = this._buildModelList(models.length > 0 ? models : FALLBACK_MODELS);
        } catch (err) {
            logger.warn(`[CopilotApiService] listModels failed, using fallback: ${err.message}`);
            this._cachedModels = this._buildModelList(FALLBACK_MODELS);
        }

        this._modelsCachedAt = Date.now();
        return this._cachedModels;
    }

    /**
     * Refresh token if near expiry (Copilot JWT auto-refreshes on demand;
     * this method just invalidates the cache so the next request re-exchanges).
     */
    async refreshToken() {
        if (!this.isInitialized) await this.initialize();
        if (this.isExpiryDateNear()) {
            logger.info('[CopilotApiService] JWT near expiry, invalidating cache...');
            this._tokenStore.invalidateJwt();
        }
    }

    /**
     * Force-refresh the Copilot JWT regardless of expiry.
     */
    async forceRefreshToken() {
        if (!this.isInitialized) await this.initialize();
        logger.info('[CopilotApiService] Force-refreshing Copilot JWT...');
        this._tokenStore.invalidateJwt();
        // Pre-warm the new JWT
        await this._tokenStore.getValidCopilotJwt();
    }

    /**
     * Returns true if the Copilot JWT expires within 5 minutes.
     * @returns {boolean}
     */
    isExpiryDateNear() {
        if (!this._tokenStore) return false;
        return this._tokenStore.isExpiryDateNear(5);
    }

    // ---------- Internal ----------

    async _ensureInitialized() {
        if (!this.isInitialized) await this.initialize();
    }

    /**
     * Fetch models from the Copilot /models endpoint.
     * @param {string} jwtToken
     * @param {string} apiEndpoint
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async _fetchModels(jwtToken, apiEndpoint) {
        const url = apiEndpoint + COPILOT_MODELS_PATH;

        let resp;
        try {
            resp = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${jwtToken}`,
                    'Accept': 'application/json',
                    'User-Agent': COPILOT_USER_AGENT,
                    'Editor-Version': COPILOT_EDITOR_VERSION,
                    'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
                    'Openai-Intent': COPILOT_OPENAI_INTENT,
                    'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
                    'X-Github-Api-Version': COPILOT_GITHUB_API_VERSION,
                },
            });
        } catch (err) {
            throw new Error(`Models fetch network error: ${err.message}`);
        }

        const bodyText = await resp.text();

        if (!resp.ok) {
            throw new Error(`Models fetch failed (${resp.status}): ${bodyText}`);
        }

        let parsed;
        try {
            parsed = JSON.parse(bodyText);
        } catch {
            throw new Error('Models response is not valid JSON');
        }

        const entries = Array.isArray(parsed.data) ? parsed.data : [];
        const seen = new Set();
        const result = [];

        for (const entry of entries) {
            if (!entry.id || seen.has(entry.id)) continue;
            seen.add(entry.id);
            result.push({ id: entry.id, name: entry.name || entry.id });
        }

        logger.info(`[CopilotApiService] Fetched ${result.length} models from API`);
        return result;
    }

    /**
     * Convert a list of model descriptors to an OpenAI-format model list response.
     * @param {Array<{id: string, name?: string}>} models
     * @returns {object}
     */
    _buildModelList(models) {
        const now = Math.floor(Date.now() / 1000);
        return {
            object: 'list',
            data: models.map((m) => ({
                id: m.id,
                object: 'model',
                created: now,
                owned_by: 'github-copilot',
            })),
        };
    }

    /**
     * Build the required HTTP headers for a Copilot API request.
     * Sets X-Initiator based on the last message role (user vs agent).
     * Adds Copilot-Vision-Request if the body contains image content.
     *
     * @param {string} jwtToken
     * @param {object} body - The parsed request body (for role / vision detection)
     * @returns {object} Headers map
     */
    _buildHeaders(jwtToken, body) {
        const initiator = this._detectInitiator(body);
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
            'Accept': 'application/json',
            'User-Agent': COPILOT_USER_AGENT,
            'Editor-Version': COPILOT_EDITOR_VERSION,
            'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
            'Openai-Intent': COPILOT_OPENAI_INTENT,
            'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
            'X-Github-Api-Version': COPILOT_GITHUB_API_VERSION,
            'X-Request-Id': randomUUID(),
            'X-Initiator': initiator,
        };

        if (this._hasVisionContent(body)) {
            headers['Copilot-Vision-Request'] = 'true';
        }

        return headers;
    }

    /**
     * Detect whether to use 'user' or 'agent' as X-Initiator based on the last
     * non-empty role in messages (or input array for Responses API).
     * @param {object} body
     * @returns {'user'|'agent'}
     */
    _detectInitiator(body) {
        if (!body) return 'user';

        const messages = body.messages;
        if (Array.isArray(messages)) {
            for (let i = messages.length - 1; i >= 0; i--) {
                const role = messages[i]?.role;
                if (role) {
                    return (role === 'assistant' || role === 'tool') ? 'agent' : 'user';
                }
            }
        }

        return 'user';
    }

    /**
     * Check whether the request body contains vision/image content blocks.
     * @param {object} body
     * @returns {boolean}
     */
    _hasVisionContent(body) {
        if (!body) return false;

        const messages = body.messages;
        if (!Array.isArray(messages)) return false;

        for (const msg of messages) {
            const content = msg?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    const t = block?.type;
                    if (t === 'image_url' || t === 'image') return true;
                }
            }
        }

        return false;
    }
}
