/**
 * codebuddy-oauth.js
 *
 * CodeBuddy (Tencent) Browser OAuth polling flow.
 *
 * Flow:
 *   1. POST /v2/plugin/auth/state?platform=CLI  → { auth_url, state }
 *   2. Open auth_url in the browser (or print it for the user).
 *   3. Poll GET /v2/plugin/auth/token?state=...  every 5 s (max 5 min).
 *   4. On success (code 0), save { access_token, refresh_token, expires_at, user_id, domain }
 *      to configs/codebuddy/{timestamp}_codebuddy-auth-token/token.json
 *   5. Broadcast oauth_success and auto-link to provider pools.
 *
 * Also exports refreshCodeBuddyToken() which is called by CodeBuddyTokenStore.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';

// ============================================================================
// Constants
// ============================================================================

const CODEBUDDY_BASE_URL = 'https://copilot.tencent.com';
const STATE_PATH = '/v2/plugin/auth/state';
const POLL_PATH = '/v2/plugin/auth/token';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';

const USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2';
const DEFAULT_DOMAIN = 'www.codebuddy.cn';

const POLL_INTERVAL_MS = 5_000;       // 5 seconds
const MAX_POLL_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const CODE_SUCCESS = 0;
const CODE_PENDING = 11217;

// ============================================================================
// JWT helpers
// ============================================================================

/**
 * Decode the `sub` claim from a JWT access token to get the user ID.
 * Non-fatal: returns '' on any error.
 *
 * @param {string} accessToken
 * @returns {string}
 */
function decodeUserIdFromJWT(accessToken) {
    try {
        const parts = accessToken.split('.');
        if (parts.length < 2) return '';
        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
        const claims = JSON.parse(payload);
        return claims.sub || '';
    } catch (_) {
        return '';
    }
}

// ============================================================================
// HTTP helpers
// ============================================================================

/**
 * Common headers used for unauthenticated CodeBuddy requests (state + poll).
 * @returns {Record<string, string>}
 */
function unauthHeaders() {
    return {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
        'X-Product': 'SaaS',
    };
}

// ============================================================================
// Token file persistence
// ============================================================================

/**
 * Persist a token object to the configs/codebuddy directory.
 * Directory layout: configs/codebuddy/{timestamp}_codebuddy-auth-token/token.json
 *
 * @param {object} tokenData
 * @returns {Promise<string>} Absolute path to the saved file.
 */
async function saveTokenFile(tokenData) {
    const timestamp = Date.now();
    const dirName = `${timestamp}_codebuddy-auth-token`;
    const tokenDir = path.join(process.cwd(), 'configs', 'codebuddy', dirName);
    const tokenFile = path.join(tokenDir, 'token.json');

    await fs.mkdir(tokenDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(tokenFile, JSON.stringify(tokenData, null, 2), { encoding: 'utf8', mode: 0o600 });
    logger.info(`[CodeBuddyOAuth] Token saved to ${tokenFile}`);
    return tokenFile;
}

// ============================================================================
// OAuth flow steps
// ============================================================================

/**
 * Step 1: Request a new auth state from the CodeBuddy state endpoint.
 * Returns { state, authUrl }.
 *
 * @returns {Promise<{ state: string, authUrl: string }>}
 */
async function fetchAuthState() {
    const url = `${CODEBUDDY_BASE_URL}${STATE_PATH}?platform=CLI`;

    const response = await fetch(url, {
        method: 'POST',
        headers: unauthHeaders(),
        body: '{}',
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`[CodeBuddyOAuth] Auth state request failed (${response.status}): ${text}`);
    }

    const json = await response.json();
    if (json.code !== CODE_SUCCESS) {
        throw new Error(`[CodeBuddyOAuth] Auth state error (code ${json.code}): ${json.msg}`);
    }
    if (!json.data?.state || !json.data?.authUrl) {
        throw new Error('[CodeBuddyOAuth] Auth state response missing state or authUrl');
    }

    return { state: json.data.state, authUrl: json.data.authUrl };
}

/**
 * Step 2: Poll for the token until the user completes browser login.
 *
 * @param {string} state
 * @returns {Promise<object>} Raw token data from the API.
 */
async function pollForToken(state) {
    const pollUrl = `${CODEBUDDY_BASE_URL}${POLL_PATH}?state=${encodeURIComponent(state)}`;
    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        let json;
        try {
            const response = await fetch(pollUrl, {
                method: 'GET',
                headers: unauthHeaders(),
            });
            if (!response.ok) {
                logger.debug(`[CodeBuddyOAuth] Poll returned ${response.status}, retrying...`);
                continue;
            }
            json = await response.json();
        } catch (err) {
            logger.debug(`[CodeBuddyOAuth] Poll request error: ${err.message}, retrying...`);
            continue;
        }

        switch (json.code) {
            case CODE_SUCCESS:
                if (!json.data) {
                    throw new Error('[CodeBuddyOAuth] Poll succeeded but data is empty');
                }
                return json.data;

            case CODE_PENDING:
                // User hasn't completed login yet — keep polling
                logger.debug('[CodeBuddyOAuth] Still pending, continuing to poll...');
                break;

            default:
                throw new Error(`[CodeBuddyOAuth] Poll error (code ${json.code}): ${json.msg}`);
        }
    }

    throw new Error('[CodeBuddyOAuth] Authorization timed out after 5 minutes');
}

// ============================================================================
// Public: handleCodeBuddyOAuth
// ============================================================================

/**
 * Initiate the CodeBuddy browser OAuth polling flow.
 *
 * This function:
 *  1. Fetches the auth state (state + authUrl).
 *  2. Launches background polling.
 *  3. Returns immediately with { authUrl, authInfo } so the caller can
 *     display or open the URL before polling completes.
 *
 * The background polling task saves the token file and broadcasts events
 * once the user completes browser authorization.
 *
 * @param {object} [_config] - Unused; kept for API consistency with other OAuth handlers.
 * @returns {Promise<{ authUrl: string, authInfo: object }>}
 */
export async function handleCodeBuddyOAuth(_config) {
    logger.info('[CodeBuddyOAuth] Starting OAuth flow...');

    const { state, authUrl } = await fetchAuthState();

    logger.info(`[CodeBuddyOAuth] Auth URL: ${authUrl}`);
    logger.info('[CodeBuddyOAuth] Waiting for browser authorization...');

    // Start background polling — do NOT await, return immediately
    (async () => {
        try {
            const rawToken = await pollForToken(state);

            const userId = decodeUserIdFromJWT(rawToken.accessToken || '');
            const expiresAt = typeof rawToken.expiresIn === 'number'
                ? Date.now() + rawToken.expiresIn * 1000
                : Date.now() + 30 * 24 * 60 * 60 * 1000; // default 30 days

            const tokenData = {
                access_token: rawToken.accessToken,
                refresh_token: rawToken.refreshToken,
                expires_at: expiresAt,
                user_id: userId,
                domain: rawToken.domain || DEFAULT_DOMAIN,
                type: 'codebuddy',
            };

            const credPath = await saveTokenFile(tokenData);
            const relativePath = path.relative(process.cwd(), credPath);

            broadcastEvent('oauth_success', {
                provider: 'openai-codebuddy-oauth',
                credPath,
                relativePath,
                timestamp: new Date().toISOString(),
            });

            // Auto-link the new credential to provider pools
            await autoLinkProviderConfigs(CONFIG, {
                onlyCurrentCred: true,
                credPath: relativePath,
            });

            logger.info(`[CodeBuddyOAuth] Authorization successful! User ID: ${userId}`);
        } catch (err) {
            logger.error(`[CodeBuddyOAuth] Polling failed: ${err.message}`);
            broadcastEvent('oauth_error', {
                provider: 'openai-codebuddy-oauth',
                error: err.message,
                timestamp: new Date().toISOString(),
            });
        }
    })();

    return {
        authUrl,
        authInfo: {
            provider: 'openai-codebuddy-oauth',
            state,
            pollIntervalMs: POLL_INTERVAL_MS,
            maxPollDurationMs: MAX_POLL_DURATION_MS,
        },
    };
}

// ============================================================================
// Public: refreshCodeBuddyToken
// ============================================================================

/**
 * Exchange a refresh token for a new access token.
 * Called by CodeBuddyTokenStore._doRefresh().
 *
 * @param {string} accessToken  - Current (possibly expired) access token.
 * @param {string} refreshToken - The refresh token to exchange.
 * @param {string} userId       - User ID extracted from the JWT sub claim.
 * @param {string} [domain]     - CodeBuddy service domain (defaults to www.codebuddy.cn).
 * @returns {Promise<{ access_token, refresh_token, expires_at, user_id, domain }>}
 */
export async function refreshCodeBuddyToken(accessToken, refreshToken, userId, domain) {
    const effectiveDomain = domain || DEFAULT_DOMAIN;
    const url = `${CODEBUDDY_BASE_URL}${REFRESH_PATH}`;

    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Domain': effectiveDomain,
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-User-Id': userId,
        'X-Product': 'SaaS',
        'Authorization': `Bearer ${accessToken}`,
    };

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: '{}',
    });

    if (response.status === 401 || response.status === 403) {
        throw new Error(`[CodeBuddyOAuth] Refresh token rejected (status ${response.status})`);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`[CodeBuddyOAuth] Token refresh failed (${response.status}): ${text}`);
    }

    const json = await response.json();
    if (json.code !== CODE_SUCCESS) {
        throw new Error(`[CodeBuddyOAuth] Token refresh error (code ${json.code}): ${json.msg}`);
    }
    if (!json.data) {
        throw new Error('[CodeBuddyOAuth] Empty data in refresh response');
    }

    const data = json.data;
    const newUserId = decodeUserIdFromJWT(data.accessToken || '') || userId;
    const newDomain = data.domain || effectiveDomain;
    const expiresAt = typeof data.expiresIn === 'number'
        ? Date.now() + data.expiresIn * 1000
        : Date.now() + 30 * 24 * 60 * 60 * 1000;

    const newTokens = {
        access_token: data.accessToken,
        refresh_token: data.refreshToken || refreshToken,
        expires_at: expiresAt,
        user_id: newUserId,
        domain: newDomain,
        type: 'codebuddy',
    };

    logger.info(`[CodeBuddyOAuth] Token refreshed successfully for user ${newUserId}`);
    return newTokens;
}
