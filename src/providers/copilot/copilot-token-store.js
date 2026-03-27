/**
 * copilot-token-store.js
 *
 * Two-tier token management for GitHub Copilot:
 *   Tier 1: GitHub access_token (long-lived, persisted to file)
 *   Tier 2: Copilot JWT (25-min TTL, obtained via /copilot_internal/v2/token)
 *
 * Concurrent refresh is deduplicated via a shared Promise so that multiple
 * simultaneous requests only trigger one upstream call.
 */

import { promises as fs } from 'node:fs';
import logger from '../../utils/logger.js';

// Lazy import to avoid circular dependency
let _refreshCopilotToken = null;
async function getRefreshFn() {
    if (!_refreshCopilotToken) {
        const mod = await import('../../auth/copilot-oauth.js');
        _refreshCopilotToken = mod.refreshCopilotToken;
    }
    return _refreshCopilotToken;
}

// Copilot JWT expires in 25 minutes; refresh 5 minutes early
const COPILOT_JWT_TTL_MS = 25 * 60 * 1000;
const COPILOT_JWT_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Token exchange endpoint
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

// Common headers for GitHub API requests
const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.35.0';
const COPILOT_EDITOR_VERSION = 'vscode/1.107.0';
const COPILOT_PLUGIN_VERSION = 'copilot-chat/0.35.0';

export class CopilotTokenStore {
    /**
     * @param {string} credFilePath - Absolute path to the GitHub token JSON file.
     */
    constructor(credFilePath) {
        this.credFilePath = credFilePath;

        /** @type {{ access_token: string, token_type?: string, scope?: string, username?: string }|null} */
        this._githubToken = null;

        /** @type {{ token: string, expiresAt: number, apiEndpoint: string }|null} */
        this._copilotJwt = null;

        /** @type {Promise<void>|null} — dedup concurrent JWT refresh */
        this._jwtRefreshPromise = null;
    }

    /**
     * Load the GitHub access token from the credential file.
     * Must be called once before any other method.
     */
    async initialize() {
        try {
            const raw = await fs.readFile(this.credFilePath, 'utf8');
            const data = JSON.parse(raw);

            if (!data.access_token) {
                throw new Error('access_token field is missing from credential file');
            }

            this._githubToken = data;
            logger.info(`[CopilotTokenStore] Loaded GitHub token from ${this.credFilePath}`);
        } catch (err) {
            this._githubToken = null;
            logger.warn(`[CopilotTokenStore] Failed to load tokens: ${err.message}`);
            throw new Error(`Copilot credential file not found or invalid: ${this.credFilePath}`);
        }
    }

    /**
     * Returns the GitHub access token (long-lived).
     * @returns {string}
     */
    getGitHubAccessToken() {
        if (!this._githubToken?.access_token) {
            throw new Error('Not authenticated. Please complete the Copilot OAuth flow first.');
        }
        return this._githubToken.access_token;
    }

    /**
     * Returns a valid Copilot JWT, exchanging/refreshing if necessary.
     * Concurrent callers share a single refresh promise to avoid duplicate calls.
     *
     * @returns {Promise<{ token: string, apiEndpoint: string }>}
     */
    async getValidCopilotJwt() {
        // Token still fresh
        if (this._copilotJwt && (this._copilotJwt.expiresAt - Date.now()) > COPILOT_JWT_REFRESH_BUFFER_MS) {
            return { token: this._copilotJwt.token, apiEndpoint: this._copilotJwt.apiEndpoint };
        }

        // Dedup concurrent refresh
        if (this._jwtRefreshPromise) {
            await this._jwtRefreshPromise;
            if (!this._copilotJwt) throw new Error('Copilot JWT refresh failed.');
            return { token: this._copilotJwt.token, apiEndpoint: this._copilotJwt.apiEndpoint };
        }

        this._jwtRefreshPromise = this._exchangeForJwt();
        try {
            await this._jwtRefreshPromise;
        } finally {
            this._jwtRefreshPromise = null;
        }

        if (!this._copilotJwt) throw new Error('Copilot JWT refresh failed.');
        return { token: this._copilotJwt.token, apiEndpoint: this._copilotJwt.apiEndpoint };
    }

    /**
     * Check whether the GitHub token file is readable and present.
     * @returns {boolean}
     */
    hasGitHubToken() {
        return !!(this._githubToken?.access_token);
    }

    /**
     * Returns true if the Copilot JWT expires within `nearMinutes` minutes.
     * @param {number} [nearMinutes=5]
     * @returns {boolean}
     */
    isExpiryDateNear(nearMinutes = 5) {
        if (!this._copilotJwt) return true;
        return (this._copilotJwt.expiresAt - Date.now()) < nearMinutes * 60 * 1000;
    }

    /**
     * Force-invalidate the cached Copilot JWT so the next call re-exchanges it.
     */
    invalidateJwt() {
        this._copilotJwt = null;
    }

    // ============================================================================
    // Internal
    // ============================================================================

    /**
     * Exchange the GitHub access token for a Copilot JWT.
     * Also validates that the GitHub token itself is still working.
     */
    async _exchangeForJwt() {
        const accessToken = this.getGitHubAccessToken();

        logger.info('[CopilotTokenStore] Exchanging GitHub token for Copilot JWT...');

        let resp;
        try {
            resp = await fetch(COPILOT_TOKEN_URL, {
                method: 'GET',
                headers: {
                    'Authorization': `token ${accessToken}`,
                    'Accept': 'application/json',
                    'User-Agent': COPILOT_USER_AGENT,
                    'Editor-Version': COPILOT_EDITOR_VERSION,
                    'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
                },
            });
        } catch (err) {
            throw new Error(`Copilot token exchange network error: ${err.message}`);
        }

        const body = await resp.text();

        if (!resp.ok) {
            throw new Error(`Copilot token exchange failed (${resp.status}): ${body}`);
        }

        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch {
            throw new Error('Copilot token exchange returned invalid JSON');
        }

        if (!parsed.token) {
            if (parsed.error_details) {
                throw new Error(`Copilot token exchange error: ${parsed.error_details.message || JSON.stringify(parsed.error_details)}`);
            }
            throw new Error('Copilot token exchange returned empty token');
        }

        // Determine expiry: use server-provided expires_at (Unix seconds) or fallback to 25-min TTL
        let expiresAt;
        if (parsed.expires_at && parsed.expires_at > 0) {
            expiresAt = parsed.expires_at * 1000; // convert to ms
        } else {
            expiresAt = Date.now() + COPILOT_JWT_TTL_MS;
        }

        // Prefer the API endpoint from the token response (may differ per account type)
        const ALLOWED_HOSTS = new Set([
            'api.githubcopilot.com',
            'api.individual.githubcopilot.com',
            'api.business.githubcopilot.com',
            'copilot-proxy.githubusercontent.com',
        ]);
        const DEFAULT_ENDPOINT = 'https://api.individual.githubcopilot.com';

        let apiEndpoint = DEFAULT_ENDPOINT;
        if (parsed.endpoints?.api) {
            try {
                const u = new URL(parsed.endpoints.api);
                if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname)) {
                    apiEndpoint = parsed.endpoints.api.replace(/\/$/, '');
                } else {
                    logger.warn(`[CopilotTokenStore] Ignoring untrusted API endpoint: ${parsed.endpoints.api}`);
                }
            } catch {
                logger.warn(`[CopilotTokenStore] Could not parse API endpoint URL: ${parsed.endpoints.api}`);
            }
        }

        this._copilotJwt = { token: parsed.token, expiresAt, apiEndpoint };

        const expiresIn = Math.round((expiresAt - Date.now()) / 60000);
        logger.info(`[CopilotTokenStore] Copilot JWT obtained, expires in ~${expiresIn}min, endpoint: ${apiEndpoint}`);
    }
}
