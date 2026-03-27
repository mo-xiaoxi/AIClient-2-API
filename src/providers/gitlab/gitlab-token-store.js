/**
 * gitlab-token-store.js
 *
 * Token management for GitLab Duo:
 *   - Load credentials from JSON file (access_token, refresh_token, etc.)
 *   - Automatic token refresh with 5-minute buffer
 *   - Concurrent refresh deduplication via shared Promise
 *   - Duo Gateway direct access token management
 */

import { promises as fs } from 'node:fs';
import logger from '../../utils/logger.js';

// Lazy import to avoid circular dependency
let _refreshGitLabToken = null;
async function getRefreshFn() {
    if (!_refreshGitLabToken) {
        const mod = await import('../../auth/gitlab-oauth.js');
        _refreshGitLabToken = mod.refreshGitLabToken;
    }
    return _refreshGitLabToken;
}

// Token refresh buffer: refresh 5 minutes before expiry
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Duo gateway direct access endpoint
const DIRECT_ACCESS_PATH = '/api/v4/code_suggestions/direct_access';

const DEFAULT_GITLAB_BASE_URL = 'https://gitlab.com';

export class GitLabTokenStore {
    /**
     * @param {string} credFilePath - Absolute path to the GitLab credential JSON file.
     */
    constructor(credFilePath) {
        this.credFilePath = credFilePath;

        /** @type {object|null} — parsed credential file contents */
        this._credentials = null;

        /** @type {{ token: string, baseUrl: string, headers: object, expiresAt: number }|null} */
        this._duoGateway = null;

        /** @type {Promise<void>|null} — dedup concurrent token refresh */
        this._refreshPromise = null;
    }

    /**
     * Load credentials from the JSON file on disk.
     * Must be called once before any other method.
     */
    async initialize() {
        try {
            const raw = await fs.readFile(this.credFilePath, 'utf8');
            const data = JSON.parse(raw);

            if (!data.access_token && !data.personal_access_token) {
                throw new Error('Neither access_token nor personal_access_token found in credential file');
            }

            this._credentials = data;
            logger.info(`[GitLabTokenStore] Loaded credentials from ${this.credFilePath}`);
        } catch (err) {
            this._credentials = null;
            logger.warn(`[GitLabTokenStore] Failed to load credentials: ${err.message}`);
            throw new Error(`GitLab credential file not found or invalid: ${this.credFilePath}`);
        }
    }

    /**
     * Returns the primary access token (OAuth or PAT).
     * @returns {string}
     */
    getAccessToken() {
        const token = this._credentials?.access_token || this._credentials?.personal_access_token;
        if (!token) {
            throw new Error('Not authenticated. Please complete the GitLab OAuth flow first.');
        }
        return token;
    }

    /**
     * Returns the GitLab instance base URL.
     * @returns {string}
     */
    getBaseUrl() {
        return normalizeBaseUrl(this._credentials?.base_url);
    }

    /**
     * Returns the auth method ('oauth' or 'pat').
     * @returns {string}
     */
    getAuthMethod() {
        return (this._credentials?.auth_method || this._credentials?.auth_kind || 'oauth').toLowerCase().trim();
    }

    /**
     * Returns a valid Duo Gateway token, refreshing via direct_access if necessary.
     * Concurrent callers share a single refresh promise to avoid duplicate calls.
     *
     * @returns {Promise<{ token: string, baseUrl: string, headers: object }>}
     */
    async getValidDuoToken() {
        // Token still fresh
        if (this._duoGateway && (this._duoGateway.expiresAt - Date.now()) > TOKEN_REFRESH_BUFFER_MS) {
            return {
                token: this._duoGateway.token,
                baseUrl: this._duoGateway.baseUrl,
                headers: this._duoGateway.headers,
            };
        }

        // Dedup concurrent refresh
        if (this._refreshPromise) {
            await this._refreshPromise;
            if (!this._duoGateway) throw new Error('GitLab Duo Gateway token refresh failed.');
            return {
                token: this._duoGateway.token,
                baseUrl: this._duoGateway.baseUrl,
                headers: this._duoGateway.headers,
            };
        }

        this._refreshPromise = this._fetchDirectAccess();
        try {
            await this._refreshPromise;
        } finally {
            this._refreshPromise = null;
        }

        if (!this._duoGateway) throw new Error('GitLab Duo Gateway token refresh failed.');
        return {
            token: this._duoGateway.token,
            baseUrl: this._duoGateway.baseUrl,
            headers: this._duoGateway.headers,
        };
    }

    /**
     * Returns true if the OAuth access token expires within `nearMinutes` minutes.
     * PAT tokens never expire (returns false).
     * @param {number} [nearMinutes=5]
     * @returns {boolean}
     */
    isExpiryDateNear(nearMinutes = 5) {
        if (this.getAuthMethod() === 'pat') return false;

        const expiresAt = this._credentials?.oauth_expires_at;
        if (!expiresAt) return true;

        const expiryMs = new Date(expiresAt).getTime();
        if (isNaN(expiryMs)) return true;

        return (expiryMs - Date.now()) < nearMinutes * 60 * 1000;
    }

    /**
     * Force-invalidate the cached Duo Gateway token so the next call re-fetches.
     */
    invalidateDuoToken() {
        this._duoGateway = null;
    }

    /**
     * Returns true if credentials are loaded.
     * @returns {boolean}
     */
    hasCredentials() {
        return !!(this._credentials?.access_token || this._credentials?.personal_access_token);
    }

    /**
     * Returns metadata about discovered models from the Duo Gateway.
     * @returns {{ modelProvider: string, modelName: string }|null}
     */
    getModelDetails() {
        if (!this._credentials?.model_details) return null;
        return {
            modelProvider: this._credentials.model_details.model_provider || '',
            modelName: this._credentials.model_details.model_name || '',
        };
    }

    // ============================================================================
    // Internal
    // ============================================================================

    /**
     * Refresh the OAuth access token using the refresh_token.
     * Updates the in-memory credentials and persists to disk.
     */
    async refreshOAuthToken() {
        if (this.getAuthMethod() !== 'oauth') return;

        const refreshToken = this._credentials?.refresh_token;
        if (!refreshToken) {
            logger.warn('[GitLabTokenStore] No refresh_token available, cannot refresh OAuth token');
            return;
        }

        if (!this.isExpiryDateNear()) {
            logger.info('[GitLabTokenStore] OAuth token still valid, skipping refresh');
            return;
        }

        logger.info('[GitLabTokenStore] Refreshing OAuth access token...');

        const refreshFn = await getRefreshFn();
        const tokenData = await refreshFn(refreshToken, {
            baseUrl: this.getBaseUrl(),
            clientId: this._credentials?.oauth_client_id || '',
            clientSecret: this._credentials?.oauth_client_secret || '',
        });

        // Update in-memory credentials
        if (tokenData.access_token) {
            this._credentials.access_token = tokenData.access_token;
        }
        if (tokenData.refresh_token) {
            this._credentials.refresh_token = tokenData.refresh_token;
        }
        if (tokenData.token_type) {
            this._credentials.token_type = tokenData.token_type;
        }
        if (tokenData.scope) {
            this._credentials.scope = tokenData.scope;
        }

        // Calculate expiry
        if (tokenData.created_at && tokenData.expires_in) {
            const expiryMs = (tokenData.created_at + tokenData.expires_in) * 1000;
            this._credentials.oauth_expires_at = new Date(expiryMs).toISOString();
        } else if (tokenData.expires_in) {
            const expiryMs = Date.now() + tokenData.expires_in * 1000;
            this._credentials.oauth_expires_at = new Date(expiryMs).toISOString();
        }

        // Persist updated credentials
        try {
            await fs.writeFile(this.credFilePath, JSON.stringify(this._credentials, null, 2), { mode: 0o600 });
            logger.info('[GitLabTokenStore] Updated credentials saved to disk');
        } catch (err) {
            logger.warn(`[GitLabTokenStore] Failed to persist updated credentials: ${err.message}`);
        }
    }

    /**
     * Fetch Duo Gateway direct access token from the GitLab instance.
     * This provides a short-lived token + gateway base URL + extra headers.
     */
    async _fetchDirectAccess() {
        // First, try refreshing the OAuth token if near expiry
        try {
            await this.refreshOAuthToken();
        } catch (err) {
            logger.warn(`[GitLabTokenStore] OAuth token refresh failed, proceeding with current token: ${err.message}`);
        }

        const accessToken = this.getAccessToken();
        const baseUrl = this.getBaseUrl();
        const url = `${baseUrl}${DIRECT_ACCESS_PATH}`;

        logger.info(`[GitLabTokenStore] Fetching Duo Gateway direct access from ${url}...`);

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json',
                },
            });
        } catch (err) {
            throw new Error(`GitLab direct access network error: ${err.message}`);
        }

        const body = await resp.text();

        if (!resp.ok) {
            throw new Error(`GitLab direct access failed (${resp.status}): ${body}`);
        }

        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch {
            throw new Error(`GitLab direct access returned invalid JSON: ${body}`);
        }

        // Extract gateway info
        const gatewayBaseUrl = (parsed.base_url || '').trim();
        const gatewayToken = (parsed.token || '').trim();
        const gatewayHeaders = parsed.headers || {};

        if (!gatewayToken) {
            // No gateway token — fall back to using the primary token directly against the GitLab instance
            logger.warn('[GitLabTokenStore] No Duo Gateway token returned, using primary token for direct API access');
            this._duoGateway = {
                token: accessToken,
                baseUrl: baseUrl,
                headers: {},
                expiresAt: Date.now() + 4 * 60 * 1000, // 4 minutes (conservative)
            };
            return;
        }

        // Calculate expiry
        let expiresAt = Date.now() + 4 * 60 * 1000; // default 4 minutes
        if (parsed.expires_at && parsed.expires_at > 0) {
            expiresAt = parsed.expires_at * 1000;
        }

        this._duoGateway = {
            token: gatewayToken,
            baseUrl: gatewayBaseUrl || baseUrl,
            headers: gatewayHeaders,
            expiresAt,
        };

        // Update model details if provided
        if (parsed.model_details) {
            if (!this._credentials) this._credentials = {};
            this._credentials.model_details = parsed.model_details;
            if (parsed.model_details.model_provider) {
                this._credentials.model_provider = parsed.model_details.model_provider;
            }
            if (parsed.model_details.model_name) {
                this._credentials.model_name = parsed.model_details.model_name;
            }
        }

        const expiresIn = Math.round((expiresAt - Date.now()) / 60000);
        logger.info(`[GitLabTokenStore] Duo Gateway token obtained, expires in ~${expiresIn}min, gateway: ${this._duoGateway.baseUrl}`);
    }
}

/**
 * Normalize a GitLab base URL.
 * @param {string} raw
 * @returns {string}
 */
function normalizeBaseUrl(raw) {
    let value = (raw || '').trim();
    if (!value) return DEFAULT_GITLAB_BASE_URL;
    if (!value.includes('://')) {
        value = 'https://' + value;
    }
    return value.replace(/\/+$/, '');
}
