/**
 * cursor-oauth.js
 *
 * Cursor PKCE OAuth flow — polling-based authentication.
 * Follows the same conventions as kiro-oauth.js / codex-oauth.js:
 *   - Saves token files to configs/cursor/{timestamp}_cursor-auth-token/
 *   - Broadcasts oauth_success / oauth_error events via broadcastEvent
 *   - Auto-links new credentials to Provider Pools via autoLinkProviderConfigs
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';

// ============================================================================
// Constants
// ============================================================================

const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl';
const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll';
const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key';

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

// ============================================================================
// PKCE helpers
// ============================================================================

async function generatePKCE() {
    const verifierBytes = new Uint8Array(96);
    crypto.getRandomValues(verifierBytes);
    const verifier = Buffer.from(verifierBytes).toString('base64url');

    const data = new TextEncoder().encode(verifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const challenge = Buffer.from(hashBuffer).toString('base64url');

    return { verifier, challenge };
}

/**
 * Extract JWT expiry (exp field) and return as milliseconds with 5-minute safety margin.
 * Falls back to 1 hour from now.
 */
function getTokenExpiry(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3 || !parts[1]) return Date.now() + 3600 * 1000;
        const decoded = JSON.parse(
            Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
        );
        if (decoded && typeof decoded.exp === 'number') {
            return decoded.exp * 1000 - 5 * 60 * 1000;
        }
    } catch {}
    return Date.now() + 3600 * 1000;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate PKCE parameters and the Cursor login URL.
 * @returns {{ verifier: string, challenge: string, uuid: string, loginUrl: string }}
 */
export async function generateCursorAuthParams() {
    const { verifier, challenge } = await generatePKCE();
    const uuid = randomUUID();

    const params = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' });
    const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
    return { verifier, challenge, uuid, loginUrl };
}

/**
 * Initiate Cursor PKCE OAuth flow.
 * Returns immediately with authUrl; starts background polling.
 *
 * @param {object} currentConfig
 * @param {object} [options]
 * @returns {{ authUrl: string, authInfo: object }}
 */
export async function handleCursorOAuth(currentConfig, options = {}) {
    const { verifier, challenge, uuid, loginUrl } = await generateCursorAuthParams();

    logger.info(`[Cursor OAuth] Generated auth URL: ${loginUrl}`);

    // Start background polling (fire-and-forget)
    _startPolling(uuid, verifier).catch((err) => {
        logger.error(`[Cursor OAuth] Background polling failed: ${err.message}`);
        broadcastEvent('oauth_error', {
            provider: 'cursor-oauth',
            error: err.message,
            timestamp: new Date().toISOString(),
        });
    });

    return {
        authUrl: loginUrl,
        authInfo: {
            provider: 'cursor-oauth',
            method: 'pkce-polling',
            uuid,
        },
    };
}

/**
 * Refresh a Cursor access token using the refresh token.
 * @param {string} refreshToken
 * @returns {Promise<{ access_token: string, refresh_token: string, expires_at: number }>}
 */
export async function refreshCursorToken(refreshToken) {
    const response = await fetch(CURSOR_REFRESH_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${refreshToken}`,
            'Content-Type': 'application/json',
        },
        body: '{}',
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Cursor token refresh failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const accessToken = data.accessToken || data.access_token;
    const newRefreshToken = data.refreshToken || data.refresh_token || refreshToken;

    if (!accessToken) {
        throw new Error('Cursor token refresh: missing access_token in response');
    }

    return {
        access_token: accessToken,
        refresh_token: newRefreshToken,
        expires_at: getTokenExpiry(accessToken),
    };
}

// ============================================================================
// Background polling
// ============================================================================

async function _startPolling(uuid, verifier) {
    logger.info(`[Cursor OAuth] Starting polling for uuid=${uuid}`);

    let delay = POLL_BASE_DELAY_MS;
    let consecutiveErrors = 0;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await _sleep(delay);

        try {
            const response = await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`);

            if (response.status === 404) {
                // Not yet authorized — continue polling
                consecutiveErrors = 0;
                // 每 10 次轮询输出一条进度日志
                if ((attempt + 1) % 10 === 0) {
                    logger.info(`[Cursor OAuth] Still polling... (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})`);
                }
                delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
                continue;
            }

            if (response.ok) {
                const data = await response.json();
                logger.info(`[Cursor OAuth] Poll returned 200, response keys: ${Object.keys(data).join(', ')}`);
                const accessToken = data.accessToken || data.access_token;
                const refreshToken = data.refreshToken || data.refresh_token;

                if (!accessToken || !refreshToken) {
                    logger.error(`[Cursor OAuth] Poll response body (sanitized): ${JSON.stringify({ hasAccessToken: !!accessToken, hasRefreshToken: !!refreshToken, keys: Object.keys(data) })}`);
                    throw new Error('Poll response missing accessToken or refreshToken');
                }

                const tokens = {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    expires_at: getTokenExpiry(accessToken),
                };

                const relativePath = await _saveTokenFile(tokens);

                broadcastEvent('oauth_success', {
                    provider: 'cursor-oauth',
                    credPath: relativePath,
                    relativePath,
                    timestamp: new Date().toISOString(),
                });

                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: relativePath,
                });

                logger.info(`[Cursor OAuth] Authentication successful, token saved to ${relativePath}`);
                return;
            }

            const errorBody = await response.text().catch(() => '');
            logger.warn(`[Cursor OAuth] Poll returned unexpected status ${response.status}: ${errorBody}`);
            throw new Error(`Poll failed: ${response.status}${errorBody ? ` - ${errorBody}` : ''}`);

        } catch (err) {
            consecutiveErrors++;
            logger.warn(`[Cursor OAuth] Polling error (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS}): ${err.message}`);
            if (consecutiveErrors >= 10) {
                throw new Error(`Too many consecutive errors during Cursor auth polling (last: ${err.message})`);
            }
            delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
        }
    }

    throw new Error('Cursor authentication polling timed out');
}

async function _saveTokenFile(tokens) {
    const timestamp = Date.now();
    const folderName = `${timestamp}_cursor-auth-token`;
    const targetDir = path.join(process.cwd(), 'configs', 'cursor', folderName);
    await fs.mkdir(targetDir, { recursive: true });

    const fileName = `${folderName}.json`;
    const credPath = path.join(targetDir, fileName);
    await fs.writeFile(credPath, JSON.stringify(tokens, null, 2), 'utf8');

    const relativePath = path.relative(process.cwd(), credPath).replace(/\\/g, '/');
    logger.info(`[Cursor OAuth] Token file saved: ${relativePath}`);
    return relativePath;
}

/**
 * Batch import Cursor tokens with streaming progress callback.
 * Each token object must contain { access_token, refresh_token }.
 *
 * @param {Array<object>} tokens - Array of token objects
 * @param {function} onProgress - Callback for progress updates
 * @param {boolean} [skipDuplicateCheck=true]
 * @returns {Promise<{ total: number, success: number, failed: number, details: Array }>}
 */
export async function batchImportCursorTokensStream(tokens, onProgress, skipDuplicateCheck = true) {
    let successCount = 0;
    let failedCount = 0;
    const details = [];

    // Read existing tokens for duplicate detection
    let existingTokens = [];
    if (!skipDuplicateCheck) {
        try {
            const cursorDir = path.join(process.cwd(), 'configs', 'cursor');
            const entries = await fs.readdir(cursorDir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const files = await fs.readdir(path.join(cursorDir, entry.name)).catch(() => []);
                    for (const file of files) {
                        if (file.endsWith('.json')) {
                            try {
                                const content = JSON.parse(
                                    await fs.readFile(path.join(cursorDir, entry.name, file), 'utf8')
                                );
                                if (content.access_token) {
                                    existingTokens.push(content.access_token);
                                }
                            } catch {}
                        }
                    }
                }
            }
        } catch {}
    }

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const progressData = { index: i + 1, total: tokens.length, current: null };

        try {
            const accessToken = token.access_token || token.accessToken;
            const refreshToken = token.refresh_token || token.refreshToken;

            if (!accessToken || !refreshToken) {
                throw new Error('Missing access_token or refresh_token');
            }

            // Duplicate check
            if (!skipDuplicateCheck && existingTokens.includes(accessToken)) {
                progressData.current = {
                    index: i + 1,
                    success: false,
                    error: 'duplicate',
                    existingPath: 'configs/cursor/'
                };
                failedCount++;
                details.push(progressData.current);
                onProgress?.({ ...progressData, successCount, failedCount });
                continue;
            }

            const normalized = {
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_at: token.expires_at || getTokenExpiry(accessToken),
            };

            const relativePath = await _saveTokenFile(normalized);

            await autoLinkProviderConfigs(CONFIG, {
                onlyCurrentCred: true,
                credPath: relativePath,
            });

            progressData.current = {
                index: i + 1,
                success: true,
                path: relativePath,
            };
            successCount++;
            existingTokens.push(accessToken);
        } catch (err) {
            logger.error(`[Cursor Batch Import] Token ${i + 1} failed:`, err.message);
            progressData.current = {
                index: i + 1,
                success: false,
                error: err.message,
            };
            failedCount++;
        }

        details.push(progressData.current);
        onProgress?.({ ...progressData, successCount, failedCount });
    }

    return { total: tokens.length, success: successCount, failed: failedCount, details };
}

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
