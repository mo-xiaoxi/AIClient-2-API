/**
 * codebuddy-core.js
 *
 * CodeBuddy (Tencent) provider service.
 * Implements the ApiServiceAdapter interface against CodeBuddy's
 * OpenAI-compatible chat completions endpoint.
 *
 * API base: https://copilot.tencent.com/v2/chat/completions
 * Auth:     Bearer access token (OAuth)
 */

import logger from '../../utils/logger.js';
import { CodeBuddyTokenStore } from './codebuddy-token-store.js';
import { getProviderModels } from '../provider-models.js';
import { MODEL_PROVIDER } from '../../utils/common.js';

// ============================================================================
// Constants
// ============================================================================

const CODEBUDDY_BASE_URL = 'https://copilot.tencent.com';
const CODEBUDDY_CHAT_PATH = '/v2/chat/completions';
const CODEBUDDY_CHAT_URL = `${CODEBUDDY_BASE_URL}${CODEBUDDY_CHAT_PATH}`;
const CODEBUDDY_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2';
const CODEBUDDY_DEFAULT_DOMAIN = 'www.codebuddy.cn';

const CODEBUDDY_MODELS = getProviderModels(MODEL_PROVIDER.CODEBUDDY_OAUTH);
const CODEBUDDY_MODEL_LIST = CODEBUDDY_MODELS.map((id) => ({
    id,
    name: id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'codebuddy',
}));

// ============================================================================
// Helper: build required request headers
// ============================================================================

/**
 * Build the set of headers required by the CodeBuddy API.
 *
 * @param {string} accessToken
 * @param {string} userId
 * @param {string} domain
 * @param {boolean} stream
 * @returns {Record<string, string>}
 */
function buildHeaders(accessToken, userId, domain, stream = false) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': stream ? 'text/event-stream' : 'application/json',
        'User-Agent': CODEBUDDY_USER_AGENT,
        'X-User-Id': userId,
        'X-Domain': domain || CODEBUDDY_DEFAULT_DOMAIN,
        'X-Product': 'SaaS',
        'X-IDE-Type': 'CLI',
        'X-IDE-Name': 'CLI',
        'X-IDE-Version': '2.63.2',
        'X-Requested-With': 'XMLHttpRequest',
    };
    if (stream) {
        headers['Cache-Control'] = 'no-cache';
    }
    return headers;
}

// ============================================================================
// CodeBuddyApiService
// ============================================================================

/**
 * CodeBuddy API service.
 *
 * Accepts OpenAI-format requestBody objects and forwards them to CodeBuddy's
 * OpenAI-compatible endpoint, returning the response as-is.
 */
export class CodeBuddyApiService {
    /**
     * @param {object} config - Provider configuration.
     * @param {string} [config.CODEBUDDY_OAUTH_CREDS_FILE_PATH] - Path to the token JSON file.
     * @param {string} [config.uuid] - Pool instance UUID.
     */
    constructor(config) {
        this.config = config;
        this.uuid = config.uuid;
        this._credFilePath = config.CODEBUDDY_OAUTH_CREDS_FILE_PATH || null;
        this._tokenStore = null;
        this.isInitialized = false;
    }

    // ---------- Lifecycle ----------

    async initialize() {
        if (this.isInitialized) return;

        if (!this._credFilePath) {
            throw new Error('[CodeBuddyApiService] CODEBUDDY_OAUTH_CREDS_FILE_PATH is not configured.');
        }

        const store = new CodeBuddyTokenStore(this._credFilePath);
        await store.initialize();
        this._tokenStore = store;
        this.isInitialized = true;
        logger.info(`[CodeBuddyApiService] Initialized (uuid=${this.uuid})`);
    }

    // ---------- Internal ----------

    async _ensureInitialized() {
        if (!this.isInitialized) {
            logger.warn('[CodeBuddyApiService] Not initialized, initializing now...');
            await this.initialize();
        }
    }

    /**
     * Perform a non-streaming POST to the CodeBuddy chat endpoint.
     *
     * @param {object} body - OpenAI-format request body (stream: false).
     * @returns {Promise<object>} Parsed JSON response.
     */
    async _callApi(body) {
        const accessToken = await this._tokenStore.getValidAccessToken();
        const userId = this._tokenStore.getUserId();
        const domain = this._tokenStore.getDomain();

        const response = await fetch(CODEBUDDY_CHAT_URL, {
            method: 'POST',
            headers: buildHeaders(accessToken, userId, domain, false),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`[CodeBuddy] API error ${response.status}: ${text}`);
        }

        return response.json();
    }

    /**
     * Perform a streaming POST to the CodeBuddy chat endpoint.
     * Returns the raw fetch Response so the caller can iterate over its body.
     *
     * @param {object} body - OpenAI-format request body (stream: true).
     * @returns {Promise<Response>}
     */
    async _callApiStream(body) {
        const accessToken = await this._tokenStore.getValidAccessToken();
        const userId = this._tokenStore.getUserId();
        const domain = this._tokenStore.getDomain();

        const response = await fetch(CODEBUDDY_CHAT_URL, {
            method: 'POST',
            headers: buildHeaders(accessToken, userId, domain, true),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`[CodeBuddy] API stream error ${response.status}: ${text}`);
        }

        return response;
    }

    // ---------- ApiServiceAdapter interface ----------

    /**
     * Non-streaming content generation.
     *
     * @param {string} _model - Model name (already in requestBody.model).
     * @param {object} requestBody - OpenAI Chat Completion request body.
     * @returns {Promise<object>} OpenAI Chat Completion response.
     */
    async generateContent(_model, requestBody) {
        await this._ensureInitialized();

        const body = { ...requestBody, stream: false };
        return this._callApi(body);
    }

    /**
     * Streaming content generation.
     * Yields parsed OpenAI streaming chunks (the objects inside `data: {...}` lines).
     *
     * @param {string} _model - Model name (already in requestBody.model).
     * @param {object} requestBody - OpenAI Chat Completion request body.
     * @yields {object} Parsed SSE data objects.
     */
    async *generateContentStream(_model, requestBody) {
        await this._ensureInitialized();

        const body = { ...requestBody, stream: true };
        const response = await this._callApiStream(body);

        // Decode the SSE stream line by line
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });

            let newlineIdx;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);

                if (!line.startsWith('data:')) continue;

                const jsonStr = line.slice(5).trim();
                if (jsonStr === '[DONE]') return;

                try {
                    yield JSON.parse(jsonStr);
                } catch (e) {
                    logger.warn('[CodeBuddyApiService] Failed to parse SSE chunk:', jsonStr);
                }
            }
        }

        // Flush any trailing content
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;
        for (const line of buffer.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') return;
            try {
                yield JSON.parse(jsonStr);
            } catch (_) { /* ignore */ }
        }
    }

    /**
     * List available models.
     * @returns {Promise<object>} OpenAI-format model list.
     */
    async listModels() {
        return { data: CODEBUDDY_MODEL_LIST, object: 'list' };
    }

    /**
     * Trigger a token refresh if the token is approaching expiry.
     * @returns {Promise<void>}
     */
    async refreshToken() {
        await this._ensureInitialized();
        if (this._tokenStore.isExpiryDateNear()) {
            logger.info('[CodeBuddyApiService] Token is near expiry, refreshing...');
            await this._tokenStore.getValidAccessToken(); // triggers refresh internally
        }
    }

    /**
     * Force a token refresh regardless of expiry.
     * @returns {Promise<void>}
     */
    async forceRefreshToken() {
        await this._ensureInitialized();
        logger.info('[CodeBuddyApiService] Force refreshing token...');
        // Touch expires_at to force the token store to refresh
        if (this._tokenStore._cached) {
            const saved = this._tokenStore._cached.expires_at;
            this._tokenStore._cached.expires_at = 0;
            try {
                await this._tokenStore.getValidAccessToken();
            } finally {
                // Restore in case of failure to avoid corrupting state beyond what _doRefresh sets
                if (this._tokenStore._cached && this._tokenStore._cached.expires_at === 0) {
                    this._tokenStore._cached.expires_at = saved;
                }
            }
        }
    }

    /**
     * Returns true if the access token will expire within 24 hours.
     * @returns {boolean}
     */
    isExpiryDateNear() {
        if (!this._tokenStore) return false;
        return this._tokenStore.isExpiryDateNear();
    }
}
