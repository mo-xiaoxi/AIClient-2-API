import { promises as fs } from 'fs';
import logger from '../../utils/logger.js';

// Lazy-load refresh function to avoid circular imports
let _refreshKimiToken = null;
async function getRefreshFn() {
    if (!_refreshKimiToken) {
        const mod = await import('../../auth/kimi-oauth.js');
        _refreshKimiToken = mod.refreshKimiToken;
    }
    return _refreshKimiToken;
}

export class KimiTokenStore {
    constructor(credFilePath) {
        this.credFilePath = credFilePath;
        this._cached = null;
        this._refreshPromise = null;
    }

    async initialize() {
        try {
            const raw = await fs.readFile(this.credFilePath, 'utf8');
            this._cached = JSON.parse(raw);
            logger.info(`[KimiTokenStore] Loaded tokens from ${this.credFilePath}`);
        } catch (err) {
            this._cached = null;
            throw new Error(`[KimiTokenStore] Token file not found: ${this.credFilePath}`);
        }
    }

    async getValidAccessToken() {
        if (!this._cached) {
            throw new Error('[KimiTokenStore] Not authenticated');
        }

        // Token still valid (with 5 minute buffer)
        if (this._cached.expires_at && Date.now() < this._cached.expires_at - 300000) {
            return this._cached.access_token;
        }

        // Need refresh
        if (!this._cached.refresh_token) {
            return this._cached.access_token; // No refresh token, use as-is
        }

        // Dedup concurrent refreshes
        if (this._refreshPromise) {
            await this._refreshPromise;
            return this._cached?.access_token;
        }

        this._refreshPromise = this._doRefresh();
        try {
            await this._refreshPromise;
        } finally {
            this._refreshPromise = null;
        }

        return this._cached?.access_token;
    }

    get deviceId() {
        return this._cached?.device_id || '';
    }

    isExpiryDateNear(nearMinutes = 5) {
        if (!this._cached?.expires_at) return false;
        return (this._cached.expires_at - Date.now()) < nearMinutes * 60 * 1000;
    }

    async _doRefresh() {
        if (!this._cached?.refresh_token) return;

        const refreshFn = await getRefreshFn();
        let newTokens;
        let lastError;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                newTokens = await refreshFn(this._cached.refresh_token, this._cached.device_id);
                break;
            } catch (err) {
                lastError = err;
                logger.warn(`[KimiTokenStore] Refresh attempt ${attempt}/3 failed: ${err.message}`);
                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
            }
        }

        if (!newTokens) {
            logger.error(`[KimiTokenStore] All refresh attempts failed: ${lastError?.message}`);
            return;
        }

        this._cached = { ...this._cached, ...newTokens };
        try {
            await fs.writeFile(this.credFilePath, JSON.stringify(this._cached, null, 2), 'utf8');
            logger.info('[KimiTokenStore] Token refreshed and saved.');
        } catch (err) {
            logger.warn(`[KimiTokenStore] Failed to persist: ${err.message}`);
        }
    }
}
