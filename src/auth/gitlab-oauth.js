/**
 * gitlab-oauth.js
 *
 * GitLab Duo authentication via OAuth2 PKCE (Authorization Code + S256).
 *
 * Flow (from Go reference):
 *   1. Generate PKCE codes (code_verifier + code_challenge with S256)
 *   2. Start local HTTP server on port 17171 for OAuth callback
 *   3. Open browser to GitLab /oauth/authorize with PKCE params
 *   4. Receive authorization code via callback
 *   5. Exchange code for tokens via POST /oauth/token
 *   6. Fetch user info via GET /api/v4/user
 *   7. Fetch direct_access token via POST /api/v4/code_suggestions/direct_access
 *   8. Save credentials to configs/gitlab/{timestamp}_gitlab-auth-token/
 *
 * Exports:
 *   handleGitLabOAuth(config)       — start PKCE flow, return authUrl + instructions
 *   refreshGitLabToken(refreshToken, opts) — refresh the OAuth access token
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_BASE_URL = 'https://gitlab.com';
const DEFAULT_CALLBACK_PORT = 17171;
const OAUTH_SCOPE = 'api read_user';

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const LOG_PREFIX = '[GitLab Auth]';

// ============================================================================
// PKCE helpers
// ============================================================================

/**
 * Generate PKCE code_verifier and code_challenge (S256).
 * @returns {{ codeVerifier: string, codeChallenge: string }}
 */
function generatePKCECodes() {
    const verifierBytes = crypto.randomBytes(32);
    const codeVerifier = verifierBytes.toString('base64url');
    const challengeHash = crypto.createHash('sha256').update(codeVerifier).digest();
    const codeChallenge = challengeHash.toString('base64url');
    return { codeVerifier, codeChallenge };
}

/**
 * Generate a random state string for CSRF protection.
 * @returns {string}
 */
function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

// ============================================================================
// Local callback server
// ============================================================================

/**
 * Start a local HTTP server to receive the OAuth callback.
 * @param {number} port
 * @returns {Promise<{ code: string, state: string }>}
 */
function waitForCallback(port) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            server.close();
            reject(new Error('OAuth callback timed out after 5 minutes.'));
        }, CALLBACK_TIMEOUT_MS);

        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${port}`);

            if (url.pathname !== '/auth/callback') {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const errorParam = url.searchParams.get('error');
            if (errorParam) {
                res.writeHead(400);
                res.end(`GitLab OAuth error: ${errorParam}`);
                clearTimeout(timeout);
                server.close();
                reject(new Error(`GitLab OAuth error: ${errorParam}`));
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');

            if (!code || !state) {
                res.writeHead(400);
                res.end('Missing code or state parameter.');
                clearTimeout(timeout);
                server.close();
                reject(new Error('Missing code or state in callback'));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><h2>GitLab authentication received. You can close this tab.</h2></body></html>');

            clearTimeout(timeout);
            server.close();
            resolve({ code, state });
        });

        server.listen(port, '127.0.0.1', () => {
            logger.info(`${LOG_PREFIX} Callback server listening on port ${port}`);
        });

        server.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Callback server error: ${err.message}`));
        });
    });
}

// ============================================================================
// Token exchange
// ============================================================================

/**
 * Exchange authorization code for tokens via POST /oauth/token.
 * @param {string} baseUrl
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} redirectUri
 * @param {string} code
 * @param {string} codeVerifier
 * @returns {Promise<object>} Token response
 */
async function exchangeCodeForTokens(baseUrl, clientId, clientSecret, redirectUri, code, codeVerifier) {
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
    });

    if (clientSecret) {
        params.set('client_secret', clientSecret);
    }

    const tokenUrl = `${baseUrl}/oauth/token`;

    const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: params.toString(),
    });

    const body = await resp.text();

    if (!resp.ok) {
        throw new Error(`Token exchange failed (${resp.status}): ${body}`);
    }

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error(`Token exchange returned invalid JSON: ${body}`);
    }

    if (!data.access_token) {
        throw new Error(`Token exchange returned no access_token: ${body}`);
    }

    return data;
}

// ============================================================================
// GitLab API helpers
// ============================================================================

/**
 * Fetch GitLab user information.
 * @param {string} baseUrl
 * @param {string} accessToken
 * @returns {Promise<{ id: number, username: string, name: string, email: string }>}
 */
async function fetchUserInfo(baseUrl, accessToken) {
    const resp = await fetch(`${baseUrl}/api/v4/user`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
        },
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Failed to fetch GitLab user info (${resp.status}): ${body}`);
    }

    const data = await resp.json();
    return {
        id: data.id,
        username: data.username || 'gitlab-user',
        name: data.name || data.username || 'GitLab User',
        email: data.email || data.public_email || '',
    };
}

/**
 * Fetch direct access token from GitLab (Duo Gateway).
 * @param {string} baseUrl
 * @param {string} accessToken
 * @returns {Promise<object>}
 */
async function fetchDirectAccess(baseUrl, accessToken) {
    const resp = await fetch(`${baseUrl}/api/v4/code_suggestions/direct_access`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
        },
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Direct access request failed (${resp.status}): ${body}`);
    }

    return await resp.json();
}

/**
 * Normalize a GitLab base URL.
 * @param {string} raw
 * @returns {string}
 */
function normalizeBaseUrl(raw) {
    let value = (raw || '').trim();
    if (!value) return DEFAULT_BASE_URL;
    if (!value.includes('://')) {
        value = 'https://' + value;
    }
    return value.replace(/\/+$/, '');
}

/**
 * Calculate token expiry time from the token response.
 * @param {object} tokenResp
 * @returns {string|null} ISO 8601 date string or null
 */
function calculateExpiry(tokenResp) {
    if (tokenResp.created_at && tokenResp.expires_in) {
        return new Date((tokenResp.created_at + tokenResp.expires_in) * 1000).toISOString();
    }
    if (tokenResp.expires_in) {
        return new Date(Date.now() + tokenResp.expires_in * 1000).toISOString();
    }
    return null;
}

// ============================================================================
// Credential persistence
// ============================================================================

/**
 * Save GitLab credentials to disk.
 * Path: configs/gitlab/{timestamp}_gitlab-auth-token/{username}.json
 *
 * @param {object} tokenData - Token response from OAuth exchange
 * @param {object} userInfo - User info from /api/v4/user
 * @param {object} directAccess - Direct access response (optional)
 * @param {object} oauthParams - { baseUrl, clientId, clientSecret }
 * @returns {Promise<{ credsPath: string, relativePath: string }>}
 */
async function saveCredentials(tokenData, userInfo, directAccess, oauthParams) {
    const projectDir = process.cwd();
    const timestamp = Date.now();
    const dirName = `${timestamp}_gitlab-auth-token`;
    const targetDir = path.join(projectDir, 'configs', 'gitlab', dirName);

    await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o700 });

    const fileName = `${userInfo.username}.json`;
    const credsPath = path.join(targetDir, fileName);

    const credentials = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || '',
        token_type: tokenData.token_type || 'bearer',
        scope: tokenData.scope || '',
        type: 'gitlab-duo',
        auth_method: 'oauth',
        auth_kind: 'oauth',
        base_url: oauthParams.baseUrl,
        oauth_client_id: oauthParams.clientId,
        oauth_client_secret: oauthParams.clientSecret || '',
        oauth_expires_at: calculateExpiry(tokenData),
        username: userInfo.username,
        email: userInfo.email,
        name: userInfo.name,
        saved_at: new Date().toISOString(),
    };

    // Merge direct access metadata
    if (directAccess) {
        if (directAccess.base_url) {
            credentials.duo_gateway_base_url = directAccess.base_url;
        }
        if (directAccess.token) {
            credentials.duo_gateway_token = directAccess.token;
        }
        if (directAccess.expires_at) {
            credentials.duo_gateway_expires_at = new Date(directAccess.expires_at * 1000).toISOString();
        }
        if (directAccess.headers) {
            credentials.duo_gateway_headers = directAccess.headers;
        }
        if (directAccess.model_details) {
            credentials.model_details = directAccess.model_details;
            if (directAccess.model_details.model_provider) {
                credentials.model_provider = directAccess.model_details.model_provider;
            }
            if (directAccess.model_details.model_name) {
                credentials.model_name = directAccess.model_details.model_name;
            }
        }
    }

    await fs.promises.writeFile(credsPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

    const relativePath = path.relative(projectDir, credsPath);
    logger.info(`${LOG_PREFIX} Credentials saved to ${relativePath}`);

    return { credsPath, relativePath };
}

// ============================================================================
// Exported functions
// ============================================================================

/**
 * Handle GitLab Duo OAuth PKCE Flow.
 *
 * Initiates the PKCE authorization code flow. Returns the authorization URL
 * so the UI can display it to the user. Authentication completes asynchronously
 * in the background — a broadcastEvent fires on success or error.
 *
 * @param {object} config - Current app configuration. Expected fields:
 *   - GITLAB_BASE_URL (optional, default: https://gitlab.com)
 *   - GITLAB_OAUTH_CLIENT_ID (required)
 *   - GITLAB_OAUTH_CLIENT_SECRET (optional, for confidential apps)
 *   - GITLAB_OAUTH_CALLBACK_PORT (optional, default: 17171)
 * @returns {Promise<object>} Result object with authUrl and instructions
 */
export async function handleGitLabOAuth(config = {}) {
    try {
        logger.info(`${LOG_PREFIX} Starting GitLab Duo OAuth PKCE Flow...`);

        const baseUrl = normalizeBaseUrl(config.GITLAB_BASE_URL || config.baseUrl);
        const clientId = (config.GITLAB_OAUTH_CLIENT_ID || config.clientId || '').trim();
        const clientSecret = (config.GITLAB_OAUTH_CLIENT_SECRET || config.clientSecret || '').trim();
        const callbackPort = config.GITLAB_OAUTH_CALLBACK_PORT || config.callbackPort || DEFAULT_CALLBACK_PORT;

        if (!clientId) {
            return {
                success: false,
                error: 'GitLab OAuth client ID is required. Please configure GITLAB_OAUTH_CLIENT_ID.',
                authInfo: {
                    provider: 'openai-gitlab-oauth',
                    method: 'pkce',
                    instructions: [
                        '1. Create an OAuth application in GitLab (Settings > Applications)',
                        '2. Set redirect URI to: http://localhost:17171/auth/callback',
                        '3. Configure GITLAB_OAUTH_CLIENT_ID with the application ID',
                        '4. Retry the authentication',
                    ],
                },
            };
        }

        const redirectUri = `http://localhost:${callbackPort}/auth/callback`;
        const { codeVerifier, codeChallenge } = generatePKCECodes();
        const state = generateState();

        // Build authorization URL
        const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            scope: OAUTH_SCOPE,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        });

        const authUrl = `${baseUrl}/oauth/authorize?${params.toString()}`;

        logger.info(`${LOG_PREFIX} Authorization URL generated`);
        logger.info(`${LOG_PREFIX} Visit: ${authUrl}`);

        // Kick off background callback listener — does not block the caller
        (async () => {
            try {
                logger.info(`${LOG_PREFIX} Waiting for OAuth callback on port ${callbackPort}...`);

                const { code, state: returnedState } = await waitForCallback(callbackPort);

                if (returnedState !== state) {
                    throw new Error('OAuth state mismatch — possible CSRF attack');
                }

                logger.info(`${LOG_PREFIX} Authorization code received, exchanging for tokens...`);

                const tokenData = await exchangeCodeForTokens(
                    baseUrl, clientId, clientSecret, redirectUri, code, codeVerifier
                );

                logger.info(`${LOG_PREFIX} Token obtained, fetching user info...`);
                let userInfo = { username: 'gitlab-user', email: '', name: 'GitLab User' };
                try {
                    userInfo = await fetchUserInfo(baseUrl, tokenData.access_token);
                } catch (e) {
                    logger.warn(`${LOG_PREFIX} Could not fetch user info: ${e.message}`);
                }

                logger.info(`${LOG_PREFIX} Authenticated as: ${userInfo.username}`);

                // Fetch direct access token
                let directAccess = null;
                try {
                    directAccess = await fetchDirectAccess(baseUrl, tokenData.access_token);
                    logger.info(`${LOG_PREFIX} Duo Gateway direct access obtained`);
                } catch (e) {
                    logger.warn(`${LOG_PREFIX} Could not fetch direct access: ${e.message}`);
                }

                const { credsPath, relativePath } = await saveCredentials(
                    tokenData, userInfo, directAccess, { baseUrl, clientId, clientSecret }
                );

                broadcastEvent('oauth_success', {
                    provider: 'openai-gitlab-oauth',
                    credPath: credsPath,
                    relativePath,
                    timestamp: new Date().toISOString(),
                    username: userInfo.username,
                    email: userInfo.email,
                });

                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: relativePath,
                });

                logger.info(`${LOG_PREFIX} OAuth flow completed for ${userInfo.username}`);
            } catch (err) {
                logger.error(`${LOG_PREFIX} Background OAuth failed: ${err.message}`);
                broadcastEvent('oauth_error', {
                    provider: 'openai-gitlab-oauth',
                    error: err.message,
                    timestamp: new Date().toISOString(),
                });
            }
        })();

        return {
            success: true,
            authUrl,
            authInfo: {
                provider: 'openai-gitlab-oauth',
                method: 'pkce',
                baseUrl,
                callbackPort,
                instructions: [
                    `1. Visit: ${authUrl}`,
                    '2. Sign in with your GitLab account',
                    '3. Authorize the application',
                    '4. Credentials will be saved automatically',
                ],
            },
        };
    } catch (err) {
        logger.error(`${LOG_PREFIX} Failed to start OAuth flow: ${err.message}`);
        return {
            success: false,
            error: err.message,
            authInfo: {
                provider: 'openai-gitlab-oauth',
                method: 'pkce',
                instructions: [
                    '1. Ensure network access to your GitLab instance',
                    '2. Verify your OAuth application configuration',
                    '3. Retry the authentication',
                ],
            },
        };
    }
}

/**
 * Refresh a GitLab OAuth token using the refresh_token.
 *
 * @param {string} refreshToken - The refresh_token from the original OAuth exchange
 * @param {object} opts - Options: { baseUrl, clientId, clientSecret }
 * @returns {Promise<object>} New token data (access_token, refresh_token, etc.)
 */
export async function refreshGitLabToken(refreshToken, opts = {}) {
    if (!refreshToken) {
        throw new Error('No refresh token provided to refreshGitLabToken');
    }

    const baseUrl = normalizeBaseUrl(opts.baseUrl);
    const clientId = (opts.clientId || '').trim();
    const clientSecret = (opts.clientSecret || '').trim();

    logger.info(`${LOG_PREFIX} Refreshing GitLab OAuth token...`);

    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    });

    if (clientId) {
        params.set('client_id', clientId);
    }
    if (clientSecret) {
        params.set('client_secret', clientSecret);
    }

    const tokenUrl = `${baseUrl}/oauth/token`;

    const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: params.toString(),
    });

    const body = await resp.text();

    if (!resp.ok) {
        throw new Error(`GitLab token refresh failed (${resp.status}): ${body}`);
    }

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error(`GitLab token refresh returned invalid JSON: ${body}`);
    }

    if (!data.access_token) {
        throw new Error(`GitLab token refresh returned no access_token: ${body}`);
    }

    logger.info(`${LOG_PREFIX} Token refreshed successfully`);

    return data;
}
