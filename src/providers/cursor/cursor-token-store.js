/**
 * cursor-token-store.js
 *
 * In-memory token cache + file-based persistence + automatic refresh
 * with concurrent deduplication for Cursor OAuth tokens.
 *
 * Token file format: { access_token, refresh_token, expires_at }
 * where expires_at is a Unix timestamp in milliseconds.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import logger from '../../utils/logger.js';

// Forward reference — resolved lazily to avoid circular import
let _refreshCursorToken = null;
async function getRefreshFn() {
    if (!_refreshCursorToken) {
        const mod = await import('../../auth/cursor-oauth.js');
        _refreshCursorToken = mod.refreshCursorToken;
    }
    return _refreshCursorToken;
}

/**
 * CursorTokenStore manages Cursor OAuth tokens.
 *
 * - On `initialize()`, reads the token file from `credFilePath`.
 * - On `getValidAccessToken()`, returns the cached token if valid, or
 *   triggers a refresh (deduplicated across concurrent callers).
 * - Refreshed tokens are persisted back to `credFilePath`.
 */
export class CursorTokenStore {
    /**
     * @param {string} credFilePath - Absolute path to the JSON token file.
     */
    constructor(credFilePath) {
        this.credFilePath = credFilePath;
        /** @type {{ access_token: string, refresh_token: string, expires_at: number }|null} */
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
            logger.info(`[CursorTokenStore] Loaded tokens from ${this.credFilePath}`);
        } catch (err) {
            this._cached = null;
            logger.warn(`[CursorTokenStore] Failed to load tokens from ${this.credFilePath}: ${err.message}`);
            throw new Error(`Cursor token file not found or invalid: ${this.credFilePath}`);
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
     * Get the currently cached token object (may be expired).
     * @returns {{ access_token: string, refresh_token: string, expires_at: number }|null}
     */
    getTokens() {
        return this._cached;
    }

    /**
     * Get a valid access token, refreshing if the current one is expired.
     * Concurrent callers share a single refresh promise.
     * @returns {Promise<string>}
     */
    async getValidAccessToken() {
        if (!this._cached) {
            throw new Error('Not authenticated. Please login via the Cursor OAuth flow first.');
        }

        // Token still valid
        if (Date.now() < this._cached.expires_at) {
            return this._cached.access_token;
        }

        logger.info('[CursorTokenStore] Access token expired, refreshing...');

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
     * Persist new tokens to memory and file.
     * @param {{ access_token: string, refresh_token: string, expires_at: number }} tokens
     */
    async saveTokens(tokens) {
        this._cached = tokens;
        try {
            await fs.mkdir(dirname(this.credFilePath), { recursive: true });
            await fs.writeFile(this.credFilePath, JSON.stringify(tokens, null, 2), 'utf8');
            logger.info('[CursorTokenStore] Tokens saved to disk.');
        } catch (err) {
            logger.warn(`[CursorTokenStore] Failed to persist tokens: ${err.message}`);
        }
    }

    /**
     * Remove cached tokens and delete the token file.
     */
    async clearTokens() {
        this._cached = null;
        try {
            await fs.unlink(this.credFilePath);
            // 尝试清理空的父目录（避免残留空目录）
            try {
                const dir = dirname(this.credFilePath);
                const entries = await fs.readdir(dir);
                if (entries.length === 0) {
                    await fs.rmdir(dir);
                    logger.info(`[CursorTokenStore] Removed empty directory: ${dir}`);
                }
            } catch {}
            logger.info('[CursorTokenStore] Tokens cleared.');
        } catch (err) {
            // File may not exist — that's fine
            logger.debug(`[CursorTokenStore] clearTokens: ${err.message}`);
        }
    }

    /**
     * Returns true if the access token expires within the given number of minutes.
     * @param {number} [nearMinutes=5]
     * @returns {boolean}
     */
    isExpiryDateNear(nearMinutes = 5) {
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
                newTokens = await refreshFn(this._cached.refresh_token);
                break;
            } catch (err) {
                lastError = err;
                logger.warn(`[CursorTokenStore] Refresh attempt ${attempt}/3 failed: ${err.message}`);
                if (attempt < 3) {
                    await new Promise((r) => setTimeout(r, 1000 * attempt));
                }
            }
        }

        if (!newTokens) {
            logger.error(`[CursorTokenStore] All refresh attempts failed: ${lastError?.message}`);
            await this.clearTokens();
            throw new Error(`Token refresh failed after 3 attempts: ${lastError?.message}`);
        }

        await this.saveTokens(newTokens);
        logger.info('[CursorTokenStore] Token refreshed successfully.');
    }
}
