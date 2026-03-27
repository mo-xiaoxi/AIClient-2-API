/**
 * kilo-oauth.js
 *
 * Kilo AI authentication via Device Code Flow.
 *
 * Flow (from Go kilo_auth.go):
 *   1. POST https://api.kilo.ai/api/device-auth/codes  → code + verificationUrl
 *   2. Display verificationUrl and code to the user
 *   3. Poll GET https://api.kilo.ai/api/device-auth/codes/{code} every 5s
 *   4. On "approved", receive token + userEmail
 *   5. Fetch profile (GET /api/profile) to get organizations
 *   6. Save credentials to configs/kilo/{timestamp}_kilo-auth-token/
 *
 * Exports:
 *   handleKiloOAuth(config)       — start Device Flow, return authUrl + polling info
 *   refreshKiloToken(accessToken) — validate the Kilo token via profile API
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

const KILO_API_BASE = 'https://api.kilo.ai/api';

const DEVICE_CODE_URL = KILO_API_BASE + '/device-auth/codes';
const PROFILE_URL = KILO_API_BASE + '/profile';

const POLL_INTERVAL_MS = 5000;   // 5 seconds
const MAX_POLL_DURATION_MS = 15 * 60 * 1000; // 15 minutes

const LOG_PREFIX = '[Kilo Auth]';

// ============================================================================
// Device Code Flow
// ============================================================================

/**
 * Request a device code from Kilo.
 * @returns {Promise<{ code: string, verificationUrl: string, expiresIn: number }>}
 */
async function requestDeviceCode() {
    const resp = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    });

    const body = await resp.text();

    if (!resp.ok && resp.status !== 201) {
        throw new Error(`Device code request failed (${resp.status}): ${body}`);
    }

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error(`Device code response is not valid JSON: ${body}`);
    }

    if (!data.code || !data.verificationUrl) {
        throw new Error(`Invalid device code response: ${body}`);
    }

    return data;
}

/**
 * Poll for device flow completion by checking the status of the given code.
 * @param {string} code - The device code to poll for
 * @returns {Promise<{ token: string, userEmail: string }>}
 */
async function pollForToken(code) {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        let resp;
        try {
            resp = await fetch(`${DEVICE_CODE_URL}/${code}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            });
        } catch (err) {
            throw new Error(`Polling network error: ${err.message}`);
        }

        const body = await resp.text();

        let data;
        try {
            data = JSON.parse(body);
        } catch {
            throw new Error(`Polling response is not valid JSON: ${body}`);
        }

        switch (data.status) {
            case 'approved':
                if (!data.token) {
                    throw new Error('Device flow approved but no token received');
                }
                return { token: data.token, userEmail: data.userEmail || '' };
            case 'denied':
                throw new Error('Authorization was denied by the user.');
            case 'expired':
                throw new Error('Device code has expired. Please start the authentication flow again.');
            case 'pending':
                continue;
            default:
                throw new Error(`Unknown device flow status: ${data.status}`);
        }
    }

    throw new Error('Authorization timed out after 15 minutes.');
}

/**
 * Fetch the user profile from Kilo API.
 * @param {string} token
 * @returns {Promise<{ email: string, organizations: Array<{ id: string, name: string }> }>}
 */
async function fetchProfile(token) {
    const resp = await fetch(PROFILE_URL, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
        },
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Failed to fetch Kilo profile (${resp.status}): ${body}`);
    }

    const data = await resp.json();
    return {
        email: data.email || '',
        organizations: data.organizations || [],
    };
}

/**
 * Fetch default settings for an organization (or user defaults).
 * @param {string} token
 * @param {string} [orgId]
 * @returns {Promise<{ model: string }>}
 */
async function fetchDefaults(token, orgId) {
    const url = orgId
        ? `${KILO_API_BASE}/organizations/${orgId}/defaults`
        : `${KILO_API_BASE}/defaults`;

    const resp = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
        },
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Failed to fetch Kilo defaults (${resp.status}): ${body}`);
    }

    const data = await resp.json();
    return { model: data.model || '' };
}

// ============================================================================
// Credential persistence
// ============================================================================

/**
 * Save Kilo token data to disk.
 * Path: configs/kilo/{timestamp}_kilo-auth-token/kilo-{email}.json
 *
 * Credential format matches Go KiloTokenStorage:
 *   { kilocodeToken, kilocodeOrganizationId, kilocodeModel, email, type: "kilo" }
 *
 * @param {string} token
 * @param {string} email
 * @param {string} organizationId
 * @param {string} model
 * @returns {Promise<{ credsPath: string, relativePath: string }>}
 */
async function saveCredentials(token, email, organizationId, model) {
    const projectDir = process.cwd();
    const timestamp = Date.now();
    const dirName = `${timestamp}_kilo-auth-token`;
    const targetDir = path.join(projectDir, 'configs', 'kilo', dirName);

    await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o700 });

    const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_') || 'unknown';
    const fileName = `kilo-${safeEmail}.json`;
    const credsPath = path.join(targetDir, fileName);

    const credentials = {
        kilocodeToken: token,
        kilocodeOrganizationId: organizationId,
        kilocodeModel: model,
        email,
        type: 'kilo',
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
 * Handle Kilo AI OAuth Device Code Flow.
 *
 * Initiates the device flow and returns the verification URL / code so
 * the UI can display them to the user. Authentication completes asynchronously
 * in the background — a broadcastEvent fires on success or error.
 *
 * @param {object} _config - Current app configuration (unused but kept for interface parity)
 * @returns {Promise<object>} Result object with authUrl, userCode, and instructions
 */
export async function handleKiloOAuth(_config = {}) {
    try {
        logger.info(`${LOG_PREFIX} Starting Kilo Device Code Flow...`);

        const deviceCodeResp = await requestDeviceCode();

        const {
            code,
            verificationUrl,
            expiresIn,
        } = deviceCodeResp;

        logger.info(`${LOG_PREFIX} Device code obtained. Code: ${code}`);
        logger.info(`${LOG_PREFIX} Visit: ${verificationUrl}`);

        // Kick off background polling — does not block the caller
        (async () => {
            try {
                logger.info(`${LOG_PREFIX} Polling for authorization (timeout: ${MAX_POLL_DURATION_MS / 60000}min)...`);

                const tokenData = await pollForToken(code);

                logger.info(`${LOG_PREFIX} Token obtained, fetching profile...`);
                let email = tokenData.userEmail || '';
                let organizationId = '';
                let model = '';

                try {
                    const profile = await fetchProfile(tokenData.token);
                    email = email || profile.email;

                    // Use first organization if available
                    if (profile.organizations.length > 0) {
                        organizationId = profile.organizations[0].id;
                        logger.info(`${LOG_PREFIX} Using organization: ${profile.organizations[0].name} (${organizationId})`);
                    }

                    // Fetch default model
                    try {
                        const defaults = await fetchDefaults(tokenData.token, organizationId);
                        model = defaults.model;
                    } catch (e) {
                        logger.warn(`${LOG_PREFIX} Could not fetch defaults: ${e.message}`);
                    }
                } catch (e) {
                    logger.warn(`${LOG_PREFIX} Could not fetch profile: ${e.message}`);
                }

                logger.info(`${LOG_PREFIX} Authenticated as: ${email || 'unknown'}`);

                const { credsPath, relativePath } = await saveCredentials(
                    tokenData.token,
                    email,
                    organizationId,
                    model,
                );

                broadcastEvent('oauth_success', {
                    provider: 'openai-kilo-oauth',
                    credPath: credsPath,
                    relativePath,
                    timestamp: new Date().toISOString(),
                    email,
                });

                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: relativePath,
                });

                logger.info(`${LOG_PREFIX} OAuth flow completed for ${email || 'unknown'}`);
            } catch (err) {
                logger.error(`${LOG_PREFIX} Background polling failed: ${err.message}`);
                broadcastEvent('oauth_error', {
                    provider: 'openai-kilo-oauth',
                    error: err.message,
                    timestamp: new Date().toISOString(),
                });
            }
        })();

        return {
            success: true,
            authUrl: verificationUrl,
            userCode: code,
            authInfo: {
                provider: 'openai-kilo-oauth',
                method: 'device-code',
                verificationUrl,
                userCode: code,
                expiresIn,
                instructions: [
                    `1. Visit: ${verificationUrl}`,
                    `2. Enter the code: ${code}`,
                    '3. Sign in with your Kilo AI account',
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
                provider: 'openai-kilo-oauth',
                method: 'device-code',
                instructions: [
                    '1. Ensure network access to api.kilo.ai',
                    '2. Retry the authentication',
                ],
            },
        };
    }
}

/**
 * Validate a Kilo token by fetching the user profile.
 *
 * Kilo tokens are long-lived (no traditional expiry / refresh mechanism).
 * This function validates the token by hitting the profile endpoint.
 *
 * @param {string} accessToken - The Kilo access token to validate
 * @returns {Promise<void>} Resolves if valid; throws if invalid
 */
export async function refreshKiloToken(accessToken) {
    if (!accessToken) {
        throw new Error('No access token provided to refreshKiloToken');
    }

    logger.info(`${LOG_PREFIX} Validating Kilo token...`);

    try {
        const profile = await fetchProfile(accessToken);
        logger.info(`${LOG_PREFIX} Token valid for user: ${profile.email || 'unknown'}`);
    } catch (err) {
        throw new Error(`Kilo token validation failed: ${err.message}`);
    }
}
