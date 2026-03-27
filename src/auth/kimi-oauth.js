import { promises as fs } from 'fs';
import * as path from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_DEVICE_CODE_URL = `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`;
const KIMI_TOKEN_URL = `${KIMI_OAUTH_HOST}/api/oauth/token`;

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function getDeviceHeaders(deviceId) {
    const platform = process.platform;
    const arch = process.arch;
    let deviceModel;
    switch (platform) {
        case 'darwin': deviceModel = `macOS ${arch}`; break;
        case 'win32': deviceModel = `Windows ${arch}`; break;
        case 'linux': deviceModel = `Linux ${arch}`; break;
        default: deviceModel = `${platform} ${arch}`;
    }
    return {
        'X-Msh-Platform': 'cli-proxy-api',
        'X-Msh-Version': '1.0.0',
        'X-Msh-Device-Name': hostname() || 'unknown',
        'X-Msh-Device-Model': deviceModel,
        'X-Msh-Device-Id': deviceId,
    };
}

/**
 * Initiate Kimi OAuth Device Code Flow
 */
export async function handleKimiOAuth() {
    const deviceId = randomUUID();

    logger.info('[Kimi OAuth] Starting device code flow...');

    const body = new URLSearchParams({ client_id: KIMI_CLIENT_ID });
    const resp = await fetch(KIMI_DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            ...getDeviceHeaders(deviceId),
        },
        body: body.toString(),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`[Kimi OAuth] Device code request failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = data;

    logger.info(`[Kimi OAuth] Device code obtained. User code: ${user_code}`);
    logger.info(`[Kimi OAuth] Please visit: ${verification_uri_complete || verification_uri}`);

    // Start background polling
    _pollForToken(device_code, deviceId, interval || 5, expires_in).catch(err => {
        logger.error(`[Kimi OAuth] Polling failed: ${err.message}`);
    });

    return {
        authUrl: verification_uri_complete || verification_uri,
        authInfo: {
            provider: 'openai-kimi-oauth',
            method: 'device-code',
            userCode: user_code,
            deviceId,
        },
    };
}

async function _pollForToken(deviceCode, deviceId, intervalSec, expiresIn) {
    const pollInterval = Math.max(intervalSec, 5) * 1000;
    const deadline = Date.now() + Math.min((expiresIn || 900) * 1000, MAX_POLL_DURATION_MS);

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval));

        const body = new URLSearchParams({
            client_id: KIMI_CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });

        try {
            const resp = await fetch(KIMI_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                    ...getDeviceHeaders(deviceId),
                },
                body: body.toString(),
            });

            const data = await resp.json();

            if (data.error) {
                if (data.error === 'authorization_pending' || data.error === 'slow_down') {
                    continue;
                }
                throw new Error(`Kimi OAuth error: ${data.error} - ${data.error_description || ''}`);
            }

            if (data.access_token) {
                const expiresAt = data.expires_in
                    ? Date.now() + data.expires_in * 1000
                    : Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days default

                const tokens = {
                    access_token: data.access_token,
                    refresh_token: data.refresh_token || '',
                    expires_at: expiresAt,
                    device_id: deviceId,
                    token_type: data.token_type || 'Bearer',
                    scope: data.scope || '',
                };

                await _saveTokenFile(tokens);
                logger.info('[Kimi OAuth] Authorization successful!');
                return tokens;
            }
        } catch (err) {
            if (err.message.includes('OAuth error')) throw err;
            logger.warn(`[Kimi OAuth] Poll error: ${err.message}`);
        }
    }

    throw new Error('[Kimi OAuth] Device code expired (timeout)');
}

async function _saveTokenFile(tokens) {
    const timestamp = Date.now();
    const folderName = `${timestamp}_kimi-auth-token`;
    const targetDir = path.join(process.cwd(), 'configs', 'kimi', folderName);
    await fs.mkdir(targetDir, { recursive: true });

    const fileName = `${folderName}.json`;
    const credPath = path.join(targetDir, fileName);
    await fs.writeFile(credPath, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });

    const relativePath = path.relative(process.cwd(), credPath).replace(/\\/g, '/');
    logger.info(`[Kimi OAuth] Token file saved: ${relativePath}`);
    return relativePath;
}

/**
 * Refresh Kimi access token using refresh token
 */
export async function refreshKimiToken(refreshToken, deviceId) {
    const body = new URLSearchParams({
        client_id: KIMI_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    });

    const resp = await fetch(KIMI_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            ...getDeviceHeaders(deviceId || randomUUID()),
        },
        body: body.toString(),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`[Kimi] Token refresh failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    if (!data.access_token) {
        throw new Error('[Kimi] Empty access token in refresh response');
    }

    const expiresAt = data.expires_in
        ? Date.now() + data.expires_in * 1000
        : Date.now() + 7 * 24 * 60 * 60 * 1000;

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_at: expiresAt,
        device_id: deviceId,
        token_type: data.token_type || 'Bearer',
        scope: data.scope || '',
    };
}
