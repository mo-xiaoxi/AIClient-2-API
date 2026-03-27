/**
 * kilo-core.js
 *
 * Kilo AI provider service. Implements ApiServiceAdapter interface.
 *
 * Authentication flow:
 *   1. Kilo Device Code Flow → long-lived access_token (stored in file)
 *   2. All API requests use the Kilo token directly as Bearer token
 *
 * Supports:
 *   - /chat/completions  (OpenAI-compatible via OpenRouter endpoint)
 *   - /models            (dynamic model discovery with static fallback)
 */

import logger from '../../utils/logger.js';
import { KiloTokenStore } from './kilo-token-store.js';

// ============================================================================
// Constants
// ============================================================================

const KILO_API_BASE = 'https://api.kilo.ai';
const KILO_CHAT_PATH = '/api/openrouter/chat/completions';
const KILO_MODELS_PATH = '/api/openrouter/models';

// Kilo request headers
const KILO_USER_AGENT = 'cli-proxy-kilo';

// Model cache TTL: 5 minutes
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const LOG_PREFIX = '[KiloApiService]';

// Static fallback model (kilo/auto is always available)
const FALLBACK_MODELS = [
    { id: 'kilo/auto', name: 'Kilo Auto' },
];

// ============================================================================
// KiloApiService
// ============================================================================

export class KiloApiService {
    constructor(config) {
        this.config = config;
        this.credFilePath = config.KILO_OAUTH_CREDS_FILE_PATH;
        this._tokenStore = null;
        this.isInitialized = false;
        this._cachedModels = null;
        this._modelsCachedAt = 0;
    }

    // ---------- Lifecycle ----------

    async initialize() {
        if (this.isInitialized) return;

        if (!this.credFilePath) {
            throw new Error(`${LOG_PREFIX} KILO_OAUTH_CREDS_FILE_PATH is not configured.`);
        }

        const store = new KiloTokenStore(this.credFilePath);
        await store.initialize();
        this._tokenStore = store;
        this.isInitialized = true;
        logger.info(`${LOG_PREFIX} Initialized successfully.`);
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
        const { token, organizationId } = this._tokenStore.getCredentials();
        const url = KILO_API_BASE + KILO_CHAT_PATH;

        const body = { ...requestBody, model, stream: false };
        const headers = this._buildHeaders(token, organizationId);

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (err) {
            throw new Error(`${LOG_PREFIX} Network error: ${err.message}`);
        }

        const responseText = await resp.text();

        if (!resp.ok) {
            const err = new Error(`Kilo API error (${resp.status}): ${responseText}`);
            err.status = resp.status;
            throw err;
        }

        try {
            return JSON.parse(responseText);
        } catch {
            throw new Error(`${LOG_PREFIX} Failed to parse response JSON: ${responseText}`);
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
        const { token, organizationId } = this._tokenStore.getCredentials();
        const url = KILO_API_BASE + KILO_CHAT_PATH;

        const body = {
            ...requestBody,
            model,
            stream: true,
            stream_options: { include_usage: true },
        };
        const headers = {
            ...this._buildHeaders(token, organizationId),
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
        };

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (err) {
            throw new Error(`${LOG_PREFIX} Network error: ${err.message}`);
        }

        if (!resp.ok) {
            const errText = await resp.text();
            const err = new Error(`Kilo API error (${resp.status}): ${errText}`);
            err.status = resp.status;
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
                        logger.warn(`${LOG_PREFIX} Failed to parse SSE chunk: ${data}`);
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
     * Filters to curated free models (preferredIndex > 0) plus kilo/auto.
     * @returns {Promise<object>}
     */
    async listModels() {
        // Return cached if still fresh
        if (this._cachedModels && (Date.now() - this._modelsCachedAt) < MODEL_CACHE_TTL_MS) {
            return this._cachedModels;
        }

        try {
            await this._ensureInitialized();
            const { token, organizationId } = this._tokenStore.getCredentials();
            const models = await this._fetchModels(token, organizationId);

            this._cachedModels = this._buildModelList(models.length > 0 ? models : FALLBACK_MODELS);
        } catch (err) {
            logger.warn(`${LOG_PREFIX} listModels failed, using fallback: ${err.message}`);
            this._cachedModels = this._buildModelList(FALLBACK_MODELS);
        }

        this._modelsCachedAt = Date.now();
        return this._cachedModels;
    }

    /**
     * Kilo tokens are long-lived; refresh is a no-op unless validation is needed.
     */
    async refreshToken() {
        if (!this.isInitialized) await this.initialize();
    }

    /**
     * Force-refresh: re-validate the token by fetching the profile.
     */
    async forceRefreshToken() {
        if (!this.isInitialized) await this.initialize();
        logger.info(`${LOG_PREFIX} Force-refreshing token (validating via profile)...`);
        await this._tokenStore.validateToken();
    }

    /**
     * Kilo tokens do not have a short-lived expiry like Copilot JWTs.
     * Always returns false since the token is long-lived.
     * @returns {boolean}
     */
    isExpiryDateNear() {
        return false;
    }

    // ---------- Internal ----------

    async _ensureInitialized() {
        if (!this.isInitialized) await this.initialize();
    }

    /**
     * Fetch models from the Kilo /models endpoint.
     * Filters to curated free models (preferredIndex > 0) plus kilo/auto.
     * @param {string} token
     * @param {string} organizationId
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async _fetchModels(token, organizationId) {
        const url = KILO_API_BASE + KILO_MODELS_PATH;

        let resp;
        try {
            resp = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    ...(organizationId ? { 'X-Kilocode-OrganizationID': organizationId } : {}),
                    'User-Agent': KILO_USER_AGENT,
                    'Accept': 'application/json',
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

        // API returns { data: [...] } or root array
        let entries;
        if (Array.isArray(parsed.data)) {
            entries = parsed.data;
        } else if (Array.isArray(parsed)) {
            entries = parsed;
        } else {
            logger.warn(`${LOG_PREFIX} Invalid API response format (expected array or data field with array)`);
            return FALLBACK_MODELS;
        }

        // Always start with kilo/auto
        const result = [{ id: 'kilo/auto', name: 'Kilo Auto' }];
        const seen = new Set(['kilo/auto']);
        let totalCount = 0;

        for (const entry of entries) {
            totalCount++;
            const id = entry.id;
            if (!id || seen.has(id)) continue;

            const preferredIndex = entry.preferredIndex || 0;

            // Filter: only curated models (preferredIndex > 0)
            if (preferredIndex <= 0) continue;

            // Filter: only free models
            const isFree = id.endsWith(':free') ||
                id === 'giga-potato' ||
                entry.is_free === true ||
                entry.pricing?.prompt === '0' ||
                entry.pricing?.prompt === '0.0';

            if (!isFree) {
                logger.debug(`${LOG_PREFIX} Skipping curated paid model: ${id}`);
                continue;
            }

            seen.add(id);
            result.push({ id, name: entry.name || id });
        }

        logger.info(`${LOG_PREFIX} Fetched ${totalCount} models from API, ${result.length - 1} curated free (preferredIndex > 0)`);
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
                owned_by: 'kilo',
            })),
        };
    }

    /**
     * Build the required HTTP headers for a Kilo API request.
     * @param {string} token
     * @param {string} organizationId
     * @returns {object} Headers map
     */
    _buildHeaders(token, organizationId) {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': KILO_USER_AGENT,
        };

        if (organizationId) {
            headers['X-Kilocode-OrganizationID'] = organizationId;
        }

        return headers;
    }
}
