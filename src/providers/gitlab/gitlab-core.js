/**
 * gitlab-core.js
 *
 * GitLab Duo provider service. Implements ApiServiceAdapter interface.
 *
 * Authentication flow:
 *   1. GitLab OAuth (PKCE) or PAT → access_token (stored in credential file)
 *   2. POST /api/v4/code_suggestions/direct_access → Duo Gateway token + base_url + headers
 *   3. All chat requests use the Duo Gateway token against the gateway base_url
 *
 * API endpoints (from Go executor reference):
 *   - Chat:             /api/v4/chat/completions (on the GitLab instance)
 *   - Code suggestions: /api/v4/code_suggestions/completions
 *   - Gateway proxy:    /ai/v1/proxy/openai/v1/chat/completions (OpenAI-compatible)
 *
 * Supports:
 *   - /chat/completions  (OpenAI-compatible via Duo Gateway)
 *   - /models            (static fallback + dynamic model discovery)
 *   - Streaming & non-streaming
 */

import { randomUUID } from 'node:crypto';
import logger from '../../utils/logger.js';
import { GitLabTokenStore } from './gitlab-token-store.js';

// ============================================================================
// Constants
// ============================================================================

// GitLab Duo Chat endpoint (on the GitLab instance itself)
const GITLAB_CHAT_ENDPOINT = '/api/v4/chat/completions';

// OpenAI-compatible chat completions path (on Duo Gateway)
const OPENAI_CHAT_PATH = '/chat/completions';

// Request headers matching Go executor reference
const GITLAB_USER_AGENT = 'APIBridge/GitLab-Duo';
const GITLAB_SSE_STREAMING_HEADER = 'X-Supports-Sse-Streaming';

// Model cache TTL: 5 minutes
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// Static fallback models — GitLab Duo typically routes to these
const FALLBACK_MODELS = [
    { id: 'gitlab-duo', name: 'GitLab Duo' },
    { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
];

// ============================================================================
// GitLabApiService
// ============================================================================

export class GitLabApiService {
    constructor(config) {
        this.config = config;
        this.credFilePath = config.GITLAB_OAUTH_CREDS_FILE_PATH;
        this._tokenStore = null;
        this.isInitialized = false;
        this._cachedModels = null;
        this._modelsCachedAt = 0;
    }

    // ---------- Lifecycle ----------

    async initialize() {
        if (this.isInitialized) return;

        if (!this.credFilePath) {
            throw new Error('[GitLabApiService] GITLAB_OAUTH_CREDS_FILE_PATH is not configured.');
        }

        const store = new GitLabTokenStore(this.credFilePath);
        await store.initialize();
        this._tokenStore = store;
        this.isInitialized = true;
        logger.info('[GitLabApiService] Initialized successfully.');
    }

    // ---------- ApiServiceAdapter interface ----------

    /**
     * Non-streaming generation. Returns OpenAI Chat Completion format.
     * Tries Duo Gateway (OpenAI-compatible) first, falls back to GitLab Chat API.
     * @param {string} model
     * @param {object} requestBody - OpenAI-format request body
     * @returns {Promise<object>}
     */
    async generateContent(model, requestBody) {
        await this._ensureInitialized();

        const body = { ...requestBody, model, stream: false };

        // Try Duo Gateway (OpenAI-compatible) first
        try {
            return await this._requestViaGateway(body, false);
        } catch (gatewayErr) {
            // If gateway fails with 403/404/405, fall back to GitLab Chat API
            if (this._shouldFallbackToChat(gatewayErr)) {
                logger.info(`[GitLabApiService] Gateway failed (${gatewayErr.status || 'unknown'}), falling back to Chat API`);
                return await this._requestViaChat(body);
            }
            throw gatewayErr;
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

        const body = {
            ...requestBody,
            model,
            stream: true,
            stream_options: { include_usage: true },
        };

        // Try Duo Gateway (OpenAI-compatible) first
        let resp;
        let useChat = false;

        try {
            resp = await this._fetchGateway(body, true);
        } catch (gatewayErr) {
            if (this._shouldFallbackToChat(gatewayErr)) {
                logger.info(`[GitLabApiService] Gateway streaming failed (${gatewayErr.status || 'unknown'}), falling back to Chat API`);
                useChat = true;
            } else {
                throw gatewayErr;
            }
        }

        if (useChat) {
            // Fallback: call Chat API synchronously and emit as stream
            const chatBody = { ...requestBody, model, stream: false };
            const chatResult = await this._requestViaChat(chatBody);
            yield* this._emitAsStream(chatResult);
            return;
        }

        // Parse SSE stream from gateway
        yield* this._parseSSEStream(resp);
    }

    /**
     * List available models. Returns OpenAI-format model list.
     * Discovers models from Duo Gateway metadata, falls back to static list.
     * @returns {Promise<object>}
     */
    async listModels() {
        // Return cached if still fresh
        if (this._cachedModels && (Date.now() - this._modelsCachedAt) < MODEL_CACHE_TTL_MS) {
            return this._cachedModels;
        }

        try {
            await this._ensureInitialized();

            // Try to discover models from the Duo Gateway token store
            const discoveredModels = this._discoverModels();
            const models = discoveredModels.length > 0 ? discoveredModels : FALLBACK_MODELS;

            this._cachedModels = this._buildModelList(models);
        } catch (err) {
            logger.warn(`[GitLabApiService] listModels failed, using fallback: ${err.message}`);
            this._cachedModels = this._buildModelList(FALLBACK_MODELS);
        }

        this._modelsCachedAt = Date.now();
        return this._cachedModels;
    }

    /**
     * Refresh token if near expiry.
     */
    async refreshToken() {
        if (!this.isInitialized) await this.initialize();
        if (this.isExpiryDateNear()) {
            logger.info('[GitLabApiService] Token near expiry, invalidating Duo Gateway cache...');
            this._tokenStore.invalidateDuoToken();
        }
    }

    /**
     * Force-refresh the Duo Gateway token regardless of expiry.
     */
    async forceRefreshToken() {
        if (!this.isInitialized) await this.initialize();
        logger.info('[GitLabApiService] Force-refreshing Duo Gateway token...');
        this._tokenStore.invalidateDuoToken();
        // Pre-warm the new token
        await this._tokenStore.getValidDuoToken();
    }

    /**
     * Returns true if the token expires within 5 minutes.
     * @returns {boolean}
     */
    isExpiryDateNear() {
        if (!this._tokenStore) return false;
        return this._tokenStore.isExpiryDateNear(5);
    }

    // ---------- Internal: Gateway (OpenAI-compatible) ----------

    /**
     * Send a request via the Duo Gateway (OpenAI-compatible endpoint).
     * @param {object} body - request body
     * @param {boolean} stream - whether this is a streaming request
     * @returns {Promise<object>} parsed JSON response (non-streaming)
     */
    async _requestViaGateway(body, stream) {
        const resp = await this._fetchGateway(body, stream);

        const responseText = await resp.text();

        if (!resp.ok) {
            const err = new Error(`GitLab Duo Gateway error (${resp.status}): ${responseText}`);
            err.status = resp.status;
            if (resp.status === 401 || resp.status === 403) {
                this._tokenStore.invalidateDuoToken();
            }
            throw err;
        }

        try {
            return JSON.parse(responseText);
        } catch {
            throw new Error(`[GitLabApiService] Failed to parse Gateway response JSON: ${responseText}`);
        }
    }

    /**
     * Low-level fetch to Duo Gateway.
     * @param {object} body
     * @param {boolean} stream
     * @returns {Promise<Response>}
     */
    async _fetchGateway(body, stream) {
        const { token, baseUrl, headers: gatewayHeaders } = await this._tokenStore.getValidDuoToken();
        const url = this._buildGatewayUrl(baseUrl) + OPENAI_CHAT_PATH;

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Accept': stream ? 'text/event-stream' : 'application/json',
            'User-Agent': GITLAB_USER_AGENT,
            'X-Request-Id': randomUUID(),
        };

        // Apply gateway-specific headers from direct_access response
        if (gatewayHeaders && typeof gatewayHeaders === 'object') {
            for (const [key, value] of Object.entries(gatewayHeaders)) {
                if (key && value) {
                    headers[key] = value;
                }
            }
        }

        // SSE-specific headers
        if (stream) {
            headers['Cache-Control'] = 'no-cache';
            headers[GITLAB_SSE_STREAMING_HEADER] = 'true';
            headers['Accept-Encoding'] = 'identity';
        }

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (err) {
            throw new Error(`[GitLabApiService] Gateway network error: ${err.message}`);
        }

        if (!resp.ok) {
            const errText = await resp.text();
            const err = new Error(`GitLab Duo Gateway error (${resp.status}): ${errText}`);
            err.status = resp.status;
            if (resp.status === 401 || resp.status === 403) {
                this._tokenStore.invalidateDuoToken();
            }
            throw err;
        }

        return resp;
    }

    /**
     * Build the OpenAI-compatible base URL from the gateway base URL.
     * Appends /v1 path if not already present.
     * @param {string} gatewayBaseUrl
     * @returns {string}
     */
    _buildGatewayUrl(gatewayBaseUrl) {
        let url = (gatewayBaseUrl || '').replace(/\/+$/, '');

        // If the gateway URL already ends with /v1, use it directly
        if (url.endsWith('/v1')) {
            return url;
        }

        // If it looks like a cloud.gitlab.com AI gateway, build the OpenAI proxy path
        if (url.includes('cloud.gitlab.com') || url.includes('/ai')) {
            // The Go reference builds: /ai/v1/proxy/openai/v1
            if (!url.includes('/proxy/openai')) {
                const base = url.replace(/\/ai\/?$/, '');
                return `${base}/ai/v1/proxy/openai/v1`;
            }
            return url;
        }

        // Default: append /v1
        return `${url}/v1`;
    }

    // ---------- Internal: GitLab Chat API fallback ----------

    /**
     * Send a request via the GitLab Chat API (non-OpenAI format).
     * Converts the OpenAI request to GitLab chat format and wraps the response.
     * @param {object} body - OpenAI-format request body
     * @returns {Promise<object>} OpenAI-format response
     */
    async _requestViaChat(body) {
        const accessToken = this._tokenStore.getAccessToken();
        const baseUrl = this._tokenStore.getBaseUrl();
        const url = `${baseUrl}${GITLAB_CHAT_ENDPOINT}`;

        // Build GitLab Chat payload from OpenAI messages
        const chatBody = this._buildChatPayload(body);

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json',
                    'User-Agent': GITLAB_USER_AGENT,
                },
                body: JSON.stringify(chatBody),
            });
        } catch (err) {
            throw new Error(`[GitLabApiService] Chat API network error: ${err.message}`);
        }

        const responseText = await resp.text();

        if (!resp.ok) {
            const err = new Error(`GitLab Chat API error (${resp.status}): ${responseText}`);
            err.status = resp.status;
            throw err;
        }

        // Parse chat response and convert to OpenAI format
        const text = this._parseChatResponse(responseText);
        return this._buildOpenAIResponse(body.model || 'gitlab-duo', text);
    }

    /**
     * Build a GitLab Chat API payload from an OpenAI-format request body.
     * @param {object} body - OpenAI-format request body
     * @returns {object}
     */
    _buildChatPayload(body) {
        const messages = body.messages || [];
        let instruction = '';
        const additionalContext = [];

        let systemIdx = 0;
        for (const msg of messages) {
            const role = (msg.role || 'user').trim();
            const content = this._extractTextContent(msg.content);
            if (!content) continue;

            if (role === 'system') {
                systemIdx++;
                additionalContext.push({
                    category: 'snippet',
                    id: `system-${systemIdx}`,
                    content,
                });
            } else if (role === 'user') {
                instruction = content;
            } else {
                additionalContext.push({
                    category: 'snippet',
                    id: `${role}-${additionalContext.length + 1}`,
                    content,
                });
            }
        }

        const payload = {
            content: instruction || '',
            with_clean_history: true,
        };

        if (additionalContext.length > 0) {
            payload.additional_context = additionalContext;
        }

        return payload;
    }

    /**
     * Extract text content from an OpenAI message content field.
     * Handles both string and array-of-blocks format.
     * @param {string|Array} content
     * @returns {string}
     */
    _extractTextContent(content) {
        if (typeof content === 'string') return content.trim();
        if (Array.isArray(content)) {
            return content
                .filter(block => block.type === 'text' && block.text)
                .map(block => block.text)
                .join('\n')
                .trim();
        }
        return '';
    }

    /**
     * Parse the GitLab Chat API response text.
     * The chat endpoint may return a JSON string, or an object with "response" field.
     * @param {string} responseText
     * @returns {string}
     */
    _parseChatResponse(responseText) {
        try {
            const parsed = JSON.parse(responseText);

            // Sometimes the response is a plain JSON string
            if (typeof parsed === 'string') return parsed.trim();

            // Object with response field
            if (parsed.response) return parsed.response.trim();

            // Object with choices (OpenAI-like)
            if (parsed.choices?.[0]?.text) return parsed.choices[0].text.trim();

            return responseText.trim();
        } catch {
            return responseText.trim();
        }
    }

    // ---------- Internal: Response builders ----------

    /**
     * Build an OpenAI-format chat completion response from text.
     * @param {string} model
     * @param {string} text
     * @returns {object}
     */
    _buildOpenAIResponse(model, text) {
        return {
            id: `gitlab-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: text,
                },
                finish_reason: 'stop',
            }],
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            },
        };
    }

    /**
     * Emit a non-streaming response as a stream of OpenAI SSE chunks.
     * @param {object} response - OpenAI chat completion response
     * @returns {AsyncGenerator<object>}
     */
    async *_emitAsStream(response) {
        const model = response.model || 'gitlab-duo';
        const text = response.choices?.[0]?.message?.content || '';
        const id = response.id || `gitlab-${Date.now()}`;
        const created = response.created || Math.floor(Date.now() / 1000);

        // Role chunk
        yield {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
                index: 0,
                delta: { role: 'assistant' },
            }],
        };

        // Content chunk
        if (text) {
            yield {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                    index: 0,
                    delta: { content: text },
                }],
            };
        }

        // Finish chunk
        yield {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop',
            }],
        };
    }

    /**
     * Parse an SSE stream response into OpenAI chunk objects.
     * @param {Response} resp - fetch Response with readable body
     * @returns {AsyncGenerator<object>}
     */
    async *_parseSSEStream(resp) {
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
                        logger.warn(`[GitLabApiService] Failed to parse SSE chunk: ${data}`);
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

    // ---------- Internal: Model discovery ----------

    /**
     * Discover models from the token store metadata.
     * @returns {Array<{id: string, name: string}>}
     */
    _discoverModels() {
        const models = [...FALLBACK_MODELS];
        const seen = new Set(models.map(m => m.id.toLowerCase()));

        const details = this._tokenStore.getModelDetails();
        if (details?.modelName) {
            const id = details.modelName.trim();
            if (id && !seen.has(id.toLowerCase())) {
                seen.add(id.toLowerCase());
                const displayName = details.modelProvider
                    ? `GitLab Duo (${details.modelProvider})`
                    : `GitLab Duo - ${id}`;
                models.unshift({ id, name: displayName });
            }
        }

        return models;
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
                owned_by: 'gitlab-duo',
            })),
        };
    }

    // ---------- Internal: Helpers ----------

    async _ensureInitialized() {
        if (!this.isInitialized) await this.initialize();
    }

    /**
     * Check if a gateway error should trigger fallback to the Chat API.
     * @param {Error} err
     * @returns {boolean}
     */
    _shouldFallbackToChat(err) {
        const status = err?.status;
        return status === 403 || status === 404 || status === 405 || status === 501;
    }
}
