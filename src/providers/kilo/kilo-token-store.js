/**
 * kilo-token-store.js
 *
 * Token management for Kilo AI:
 *   - Loads credentials from a JSON file (kilocodeToken, kilocodeOrganizationId, email)
 *   - Kilo tokens are long-lived (no short-lived JWT exchange like Copilot)
 *   - Concurrent validation is deduplicated via a shared Promise
 *
 * Credential file format (matches Go KiloTokenStorage):
 *   {
 *     "kilocodeToken": "...",
 *     "kilocodeOrganizationId": "...",
 *     "kilocodeModel": "...",
 *     "email": "...",
 *     "type": "kilo"
 *   }
 */

import { promises as fs } from 'node:fs';
import logger from '../../utils/logger.js';

// Lazy import to avoid circular dependency
let _refreshKiloToken = null;
async function getRefreshFn() {
    if (!_refreshKiloToken) {
        const mod = await import('../../auth/kilo-oauth.js');
        _refreshKiloToken = mod.refreshKiloToken;
    }
    return _refreshKiloToken;
}

const LOG_PREFIX = '[KiloTokenStore]';

export class KiloTokenStore {
    /**
     * @param {string} credFilePath - Absolute path to the Kilo credential JSON file.
     */
    constructor(credFilePath) {
        this.credFilePath = credFilePath;

        /** @type {{ kilocodeToken: string, kilocodeOrganizationId?: string, email?: string }|null} */
        this._credentials = null;

        /** @type {Promise<void>|null} — dedup concurrent token validation */
        this._validatePromise = null;
    }

    /**
     * Load the Kilo credentials from the credential file.
     * Must be called once before any other method.
     */
    async initialize() {
        try {
            const raw = await fs.readFile(this.credFilePath, 'utf8');
            const data = JSON.parse(raw);

            // Support both Kilo-specific keys and generic keys (matching Go kiloCredentials logic)
            const token = data.kilocodeToken || data.access_token;
            if (!token) {
                throw new Error('kilocodeToken (or access_token) field is missing from credential file');
            }

            this._credentials = {
                kilocodeToken: token,
                kilocodeOrganizationId: data.kilocodeOrganizationId || data.organization_id || '',
                kilocodeModel: data.kilocodeModel || '',
                email: data.email || '',
            };

            logger.info(`${LOG_PREFIX} Loaded Kilo credentials from ${this.credFilePath}`);
        } catch (err) {
            this._credentials = null;
            logger.warn(`${LOG_PREFIX} Failed to load credentials: ${err.message}`);
            throw new Error(`Kilo credential file not found or invalid: ${this.credFilePath}`);
        }
    }

    /**
     * Returns the Kilo access token and organization ID.
     * @returns {{ token: string, organizationId: string }}
     */
    getCredentials() {
        if (!this._credentials?.kilocodeToken) {
            throw new Error('Not authenticated. Please complete the Kilo OAuth flow first.');
        }
        return {
            token: this._credentials.kilocodeToken,
            organizationId: this._credentials.kilocodeOrganizationId || '',
        };
    }

    /**
     * Returns the Kilo access token.
     * @returns {string}
     */
    getAccessToken() {
        if (!this._credentials?.kilocodeToken) {
            throw new Error('Not authenticated. Please complete the Kilo OAuth flow first.');
        }
        return this._credentials.kilocodeToken;
    }

    /**
     * Check whether the credential file has been loaded and contains a token.
     * @returns {boolean}
     */
    hasToken() {
        return !!(this._credentials?.kilocodeToken);
    }

    /**
     * Validate the Kilo token by calling the profile API.
     * Concurrent callers share a single validation promise to avoid duplicate calls.
     * @returns {Promise<void>}
     */
    async validateToken() {
        // Dedup concurrent validation
        if (this._validatePromise) {
            await this._validatePromise;
            return;
        }

        this._validatePromise = this._doValidate();
        try {
            await this._validatePromise;
        } finally {
            this._validatePromise = null;
        }
    }

    // ============================================================================
    // Internal
    // ============================================================================

    /**
     * Validate the token by fetching the user profile from Kilo API.
     */
    async _doValidate() {
        const token = this.getAccessToken();

        logger.info(`${LOG_PREFIX} Validating Kilo token via profile API...`);

        try {
            const refreshFn = await getRefreshFn();
            await refreshFn(token);
            logger.info(`${LOG_PREFIX} Token validation successful.`);
        } catch (err) {
            logger.warn(`${LOG_PREFIX} Token validation failed: ${err.message}`);
            throw err;
        }
    }
}
