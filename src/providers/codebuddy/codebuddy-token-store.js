/**
 * codebuddy-token-store.js
 *
 * In-memory token cache + file-based persistence + automatic refresh
 * with concurrent deduplication for CodeBuddy OAuth tokens.
 *
 * Token file format: { access_token, refresh_token, expires_at, user_id, domain }
 * where expires_at is a Unix timestamp in milliseconds.
 *
 * Refresh lead: 24 hours before expiry (CodeBuddy tokens have a long validity period).
 */

import { promises as fs } from 'node:fs';
import logger from '../../utils/logger.js';

// Refresh 24 hours before expiry to match Go reference implementation
const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000;

// Forward reference — resolved lazily to avoid circular import
let _refreshCodeBuddyToken = null;
async function getRefreshFn() {
    if (!_refreshCodeBuddyToken) {
        const mod = await import('../../auth/codebuddy-oauth.js');
        _refreshCodeBuddyToken = mod.refreshCodeBuddyToken;
    }
    return _refreshCodeBuddyToken;
}

/**
 * Decode the `sub` claim from a JWT to extract the user ID.
 * Returns an empty string on failure (non-fatal).
 *
 * @param {string} accessToken - JWT access token
 * @returns {string}
 */
function decodeUserIdFromJWT(accessToken) {
    try {
        const parts = accessToken.split('.');
        if (parts.length < 2) return '';
        // base64url → base64 padding normalisation handled by Buffer
        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
        const claims = JSON.parse(payload);
        return claims.sub || '';
    } catch (_) {
        return '';
    }
}

/**
 * CodeBuddyTokenStore manages CodeBuddy OAuth tokens.
 *
 * - On `initialize()`, reads the token file from `credFilePath`.
 * - On `getValidAccessToken()`, returns the cached token if still valid
 *   (with a 24-hour refresh lead), or triggers a refresh (deduplicated
 *   across concurrent callers).
 * - Refreshed tokens are persisted back to `credFilePath`.
 */
export class CodeBuddyTokenStore {
    /**
     * @param {string} credFilePath - Absolute path to the JSON token file.
     */
    constructor(credFilePath) {
        this.credFilePath = credFilePath;
        /**
         * @type {{
         *   access_token: string,
         *   refresh_token: string,
         *   expires_at: number,
         *   user_id: string,
         *   domain?: string
         * }|null}
         */
        this._cached = null;
        /** @type {Promise<void>|null} */
        this._refreshPromise = null;
    }

    /**
     * Load tokens from the credential file.
     * Must be called before any other method.
     * @throws if the file does not exist or is invalid JSON.
     */
    async initialize() {
        try {
            const raw = await fs.readFile(this.credFilePath, 'utf8');
            this._cached = JSON.parse(raw);
            // Back-fill user_id from JWT if missing in stored file
            if (!this._cached.user_id && this._cached.access_token) {
                this._cached.user_id = decodeUserIdFromJWT(this._cached.access_token);
            }
            logger.info(`[CodeBuddyTokenStore] Loaded tokens from ${this.credFilePath}`);
        } catch (err) {
            this._cached = null;
            logger.warn(`[CodeBuddyTokenStore] Failed to load tokens from ${this.credFilePath}: ${err.message}`);
            throw new Error(`CodeBuddy token file not found or invalid: ${this.credFilePath}`);
        }
    }

    /**
     * Return true if we have a token with a non-empty refresh_token.
     * @returns {boolean}
     */
    hasValidToken() {
        return !!(this._cached?.refresh_token);
    }

    /**
     * Get the currently cached token object (may be near expiry).
     * @returns {{ access_token: string, refresh_token: string, expires_at: number, user_id: string, domain?: string }|null}
     */
    getTokens() {
        return this._cached;
    }

    /**
     * Get a valid access token, refreshing proactively 24 hours before expiry.
     * Concurrent callers share a single refresh promise.
     * @returns {Promise<string>}
     */
    async getValidAccessToken() {
        if (!this._cached) {
            throw new Error('Not authenticated. Please login via the CodeBuddy OAuth flow first.');
        }

        // Token is still comfortably valid (more than 24 h remaining)
        if (Date.now() < this._cached.expires_at - REFRESH_LEAD_MS) {
            return this._cached.access_token;
        }

        logger.info('[CodeBuddyTokenStore] Access token approaching expiry, refreshing...');

        // Dedup concurrent refresh requests
        if (this._refreshPromise) {
            await this._refreshPromise;
            if (!this._cached) throw new Error('Token refresh failed. Please login again.');
            return this._cached.access_token;
        }

        this._refreshPromise = this._doRefresh();
        try {
            await this._refreshPromise;
        } finally {
            this._refreshPromise = null;
        }

        if (!this._cached) throw new Error('Token refresh failed. Please login again.');
        return this._cached.access_token;
    }

    /**
     * Get the cached user ID (decoded from the JWT sub claim).
     * @returns {string}
     */
    getUserId() {
        return this._cached?.user_id || '';
    }

    /**
     * Get the cached domain (defaults to www.codebuddy.cn).
     * @returns {string}
     */
    getDomain() {
        return this._cached?.domain || 'www.codebuddy.cn';
    }

    /**
     * Persist new tokens to memory and file.
     * @param {{ access_token: string, refresh_token: string, expires_at: number, user_id: string, domain?: string }} tokens
     */
    async saveTokens(tokens) {
        this._cached = tokens;
        try {
            await fs.writeFile(this.credFilePath, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
            logger.info('[CodeBuddyTokenStore] Tokens saved to disk.');
        } catch (err) {
            logger.warn(`[CodeBuddyTokenStore] Failed to persist tokens: ${err.message}`);
        }
    }

    /**
     * Remove cached tokens and delete the token file.
     */
    async clearTokens() {
        this._cached = null;
        try {
            await fs.unlink(this.credFilePath);
            logger.info('[CodeBuddyTokenStore] Tokens cleared.');
        } catch (err) {
            logger.debug(`[CodeBuddyTokenStore] clearTokens: ${err.message}`);
        }
    }

    /**
     * Returns true if the access token will expire within the given number of minutes.
     * Uses the 24-hour lead time consistent with getValidAccessToken.
     * @param {number} [nearMinutes=24*60]
     * @returns {boolean}
     */
    isExpiryDateNear(nearMinutes = 24 * 60) {
        if (!this._cached) return false;
        return (this._cached.expires_at - Date.now()) < nearMinutes * 60 * 1000;
    }

    // ============================================================================
    // Internal
    // ============================================================================

    async _doRefresh() {
        if (!this._cached?.refresh_token) {
            throw new Error('No refresh token available. Please login again.');
        }

        const refreshFn = await getRefreshFn();
        let newTokens;
        let lastError;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                newTokens = await refreshFn(
                    this._cached.access_token,
                    this._cached.refresh_token,
                    this._cached.user_id || '',
                    this._cached.domain || 'www.codebuddy.cn',
                );
                break;
            } catch (err) {
                lastError = err;
                logger.warn(`[CodeBuddyTokenStore] Refresh attempt ${attempt}/3 failed: ${err.message}`);
                if (attempt < 3) {
                    await new Promise((r) => setTimeout(r, 1000 * attempt));
                }
            }
        }

        if (!newTokens) {
            logger.error(`[CodeBuddyTokenStore] All refresh attempts failed: ${lastError?.message}`);
            throw new Error(`Token refresh failed after 3 attempts: ${lastError?.message}`);
        }

        await this.saveTokens(newTokens);
        logger.info('[CodeBuddyTokenStore] Token refreshed successfully.');
    }
}
