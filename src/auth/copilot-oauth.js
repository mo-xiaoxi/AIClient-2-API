/**
 * copilot-oauth.js
 *
 * GitHub Copilot authentication via OAuth2 Device Code Flow.
 *
 * Flow:
 *   1. POST https://github.com/login/device/code  → device_code + user_code
 *   2. Display user_code and verification_uri to the user
 *   3. Poll POST https://github.com/login/oauth/access_token every 5s (15min timeout)
 *   4. On success, save the access_token to configs/copilot/{timestamp}_copilot-auth-token/
 *
 * Exports:
 *   handleCopilotOAuth(config)       — start Device Flow, return authUrl + polling info
 *   refreshCopilotToken(accessToken) — validate the GitHub token (no-op for long-lived tokens)
 */

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';

// ============================================================================
// Constants
// ============================================================================

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const COPILOT_SCOPE = 'read:user user:email';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_INFO_URL = 'https://api.github.com/user';

const POLL_INTERVAL_MS = 5000;   // 5 seconds
const MAX_POLL_DURATION_MS = 15 * 60 * 1000; // 15 minutes

const LOG_PREFIX = '[Copilot Auth]';

// ============================================================================
// Device Code Flow
// ============================================================================

/**
 * Request a device code from GitHub.
 * @returns {Promise<{ device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number }>}
 */
async function requestDeviceCode() {
    const params = new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        scope: COPILOT_SCOPE,
    });

    const resp = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: params.toString(),
    });

    const body = await resp.text();

    if (!resp.ok) {
        throw new Error(`Device code request failed (${resp.status}): ${body}`);
    }

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error(`Device code response is not valid JSON: ${body}`);
    }

    if (!data.device_code || !data.user_code) {
        throw new Error(`Invalid device code response: ${body}`);
    }

    return data;
}

/**
 * Attempt a single token exchange with the device_code.
 * @param {string} deviceCode
 * @returns {Promise<{ access_token: string, token_type: string, scope: string }|null>}
 *   Returns null if still pending (authorization_pending / slow_down).
 *   Throws for terminal errors (expired_token / access_denied / network).
 */
async function exchangeDeviceCode(deviceCode) {
    const params = new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: params.toString(),
    });

    const body = await resp.text();

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error(`Token exchange response is not valid JSON: ${body}`);
    }

    if (data.error) {
        switch (data.error) {
            case 'authorization_pending':
                return null; // still waiting
            case 'slow_down':
                return null; // caller will increase interval
            case 'expired_token':
                throw new Error('Device code has expired. Please start the authentication flow again.');
            case 'access_denied':
                throw new Error('Authorization was denied by the user.');
            default:
                throw new Error(`OAuth error: ${data.error} — ${data.error_description || ''}`);
        }
    }

    if (!data.access_token) {
        throw new Error(`Token exchange returned no access_token: ${body}`);
    }

    return {
        access_token: data.access_token,
        token_type: data.token_type || 'bearer',
        scope: data.scope || '',
    };
}

/**
 * Fetch GitHub user information for the authenticated token.
 * @param {string} accessToken
 * @returns {Promise<{ login: string, email: string, name: string }>}
 */
async function fetchUserInfo(accessToken) {
    const resp = await fetch(USER_INFO_URL, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
            'User-Agent': 'APIBridge',
        },
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Failed to fetch GitHub user info (${resp.status}): ${body}`);
    }

    const data = await resp.json();

    if (!data.login) {
        throw new Error('GitHub user info returned empty login');
    }

    return {
        login: data.login,
        email: data.email || '',
        name: data.name || data.login,
    };
}

/**
 * Poll for user authorization until the device code is approved or expires.
 * @param {string} deviceCode
 * @param {number} intervalMs - initial polling interval in ms
 * @returns {Promise<{ access_token: string, token_type: string, scope: string }>}
 */
async function pollForToken(deviceCode, intervalMs) {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let currentInterval = Math.max(intervalMs, POLL_INTERVAL_MS);

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, currentInterval));

        let result;
        try {
            result = await exchangeDeviceCode(deviceCode);
        } catch (err) {
            if (err.message.includes('slow_down')) {
                currentInterval += 5000;
                continue;
            }
            throw err;
        }

        if (result) return result;
        // null means authorization_pending — keep polling
    }

    throw new Error('Authorization timed out after 15 minutes.');
}

// ============================================================================
// Credential persistence
// ============================================================================

/**
 * Save GitHub token data to disk.
 * Path: configs/copilot/{timestamp}_copilot-auth-token/{username}.json
 *
 * @param {{ access_token: string, token_type: string, scope: string }} tokenData
 * @param {{ login: string, email: string, name: string }} userInfo
 * @returns {Promise<{ credsPath: string, relativePath: string }>}
 */
async function saveCredentials(tokenData, userInfo) {
    const projectDir = process.cwd();
    const timestamp = Date.now();
    const dirName = `${timestamp}_copilot-auth-token`;
    const targetDir = path.join(projectDir, 'configs', 'copilot', dirName);

    await fs.promises.mkdir(targetDir, { recursive: true });
    // Ensure restrictive permissions on credential directories
    await fs.promises.chmod(targetDir, 0o700).catch(() => {});

    const fileName = `${userInfo.login}.json`;
    const credsPath = path.join(targetDir, fileName);

    const credentials = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        scope: tokenData.scope,
        username: userInfo.login,
        email: userInfo.email,
        name: userInfo.name,
        type: 'github-copilot',
        saved_at: new Date().toISOString(),
    };

    await fs.promises.writeFile(credsPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

    const relativePath = path.relative(projectDir, credsPath);
    logger.info(`${LOG_PREFIX} Credentials saved to ${relativePath}`);

    return { credsPath, relativePath };
}

// ============================================================================
// Exported functions
// ============================================================================

/**
 * Handle GitHub Copilot OAuth Device Code Flow.
 *
 * Initiates the device flow and returns the verification URL / user code so
 * the UI can display them to the user. Authentication completes asynchronously
 * in the background — a broadcastEvent fires on success or error.
 *
 * @param {object} _config - Current app configuration (unused but kept for interface parity)
 * @returns {Promise<object>} Result object with authUrl, userCode, and instructions
 */
export async function handleCopilotOAuth(_config = {}) {
    try {
        logger.info(`${LOG_PREFIX} Starting GitHub Copilot Device Code Flow...`);

        const deviceCodeResp = await requestDeviceCode();

        const {
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: verificationUri,
            expires_in: expiresIn,
            interval: intervalSeconds,
        } = deviceCodeResp;

        logger.info(`${LOG_PREFIX} Device code obtained. User code: ${userCode}`);
        logger.info(`${LOG_PREFIX} Visit: ${verificationUri}`);

        const intervalMs = (intervalSeconds || 5) * 1000;

        // Kick off background polling — does not block the caller
        (async () => {
            try {
                logger.info(`${LOG_PREFIX} Polling for authorization (timeout: ${MAX_POLL_DURATION_MS / 60000}min)...`);

                const tokenData = await pollForToken(deviceCode, intervalMs);

                logger.info(`${LOG_PREFIX} Token obtained, fetching user info...`);
                let userInfo = { login: 'github-user', email: '', name: 'GitHub User' };
                try {
                    userInfo = await fetchUserInfo(tokenData.access_token);
                } catch (e) {
                    logger.warn(`${LOG_PREFIX} Could not fetch user info: ${e.message}`);
                }

                logger.info(`${LOG_PREFIX} Authenticated as: ${userInfo.login}`);

                const { credsPath, relativePath } = await saveCredentials(tokenData, userInfo);

                broadcastEvent('oauth_success', {
                    provider: 'openai-copilot-oauth',
                    credPath: credsPath,
                    relativePath,
                    timestamp: new Date().toISOString(),
                    username: userInfo.login,
                    email: userInfo.email,
                });

                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: relativePath,
                });

                logger.info(`${LOG_PREFIX} OAuth flow completed for ${userInfo.login}`);
            } catch (err) {
                logger.error(`${LOG_PREFIX} Background polling failed: ${err.message}`);
                broadcastEvent('oauth_error', {
                    provider: 'openai-copilot-oauth',
                    error: err.message,
                    timestamp: new Date().toISOString(),
                });
            }
        })();

        return {
            success: true,
            authUrl: verificationUri,
            userCode,
            authInfo: {
                provider: 'openai-copilot-oauth',
                method: 'device-code',
                verificationUri,
                userCode,
                expiresIn,
                instructions: [
                    `1. Visit: ${verificationUri}`,
                    `2. Enter the code: ${userCode}`,
                    '3. Sign in with your GitHub account',
                    '4. Authorize the application',
                    '5. Credentials will be saved automatically',
                ],
            },
        };
    } catch (err) {
        logger.error(`${LOG_PREFIX} Failed to start OAuth flow: ${err.message}`);
        return {
            success: false,
            error: err.message,
            authInfo: {
                provider: 'openai-copilot-oauth',
                method: 'device-code',
                instructions: [
                    '1. Ensure network access to github.com',
                    '2. Retry the authentication',
                ],
            },
        };
    }
}

/**
 * Validate / refresh a GitHub Copilot token.
 *
 * GitHub OAuth tokens for Copilot are long-lived (no traditional expiry).
 * Refreshing means verifying the token can still exchange for a Copilot JWT.
 * This function validates by fetching user info — lightweight and sufficient.
 *
 * @param {string} accessToken - The GitHub access_token to validate
 * @returns {Promise<void>} Resolves if valid; throws if invalid
 */
export async function refreshCopilotToken(accessToken) {
    if (!accessToken) {
        throw new Error('No access token provided to refreshCopilotToken');
    }

    logger.info(`${LOG_PREFIX} Validating GitHub token...`);

    try {
        const userInfo = await fetchUserInfo(accessToken);
        logger.info(`${LOG_PREFIX} Token valid for user: ${userInfo.login}`);
    } catch (err) {
        throw new Error(`Copilot token validation failed: ${err.message}`);
    }
}
