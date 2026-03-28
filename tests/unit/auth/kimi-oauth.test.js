/**
 * Unit tests for auth/kimi-oauth.js
 * Tests: handleKimiOAuth, refreshKimiToken
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

let handleKimiOAuth;
let refreshKimiToken;

let mockFsMkdir;
let mockFsWriteFile;
let originalFetch;

beforeAll(async () => {
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        default: {
            promises: {
                mkdir: (...args) => mockFsMkdir(...args),
                writeFile: (...args) => mockFsWriteFile(...args),
            },
        },
        promises: {
            mkdir: (...args) => mockFsMkdir(...args),
            writeFile: (...args) => mockFsWriteFile(...args),
        },
    }));

    const mod = await import('../../../src/auth/kimi-oauth.js');
    handleKimiOAuth = mod.handleKimiOAuth;
    refreshKimiToken = mod.refreshKimiToken;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    originalFetch = global.fetch;
    global.fetch = jest.fn();
});

afterEach(() => {
    global.fetch = originalFetch;
});

// =============================================================================
// handleKimiOAuth
// =============================================================================

describe('handleKimiOAuth', () => {
    test('returns authUrl and authInfo on valid device code response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                device_code: 'kimi-device-code',
                user_code: 'KIMI-USER',
                verification_uri: 'https://kimi.ai/verify',
                verification_uri_complete: 'https://kimi.ai/verify?code=KIMI-USER',
                expires_in: 600,
                interval: 5,
            }),
        });

        const result = await handleKimiOAuth();

        expect(result.authUrl).toBe('https://kimi.ai/verify?code=KIMI-USER');
        expect(result.authInfo).toBeDefined();
        expect(result.authInfo.provider).toBe('openai-kimi-oauth');
        expect(result.authInfo.method).toBe('device-code');
        expect(result.authInfo.userCode).toBe('KIMI-USER');
    });

    test('falls back to verification_uri when verification_uri_complete absent', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                device_code: 'dc',
                user_code: 'UC',
                verification_uri: 'https://kimi.ai/verify',
                expires_in: 600,
                interval: 5,
            }),
        });

        const result = await handleKimiOAuth();
        expect(result.authUrl).toBe('https://kimi.ai/verify');
    });

    test('throws when device code request fails', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            text: async () => 'Service Unavailable',
        });

        await expect(handleKimiOAuth()).rejects.toThrow('Device code request failed');
    });

    test('authInfo contains deviceId', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                device_code: 'dc',
                user_code: 'UC',
                verification_uri: 'https://kimi.ai/verify',
                expires_in: 600,
                interval: 5,
            }),
        });

        const result = await handleKimiOAuth();
        expect(result.authInfo.deviceId).toBeDefined();
        expect(typeof result.authInfo.deviceId).toBe('string');
    });
});

// =============================================================================
// refreshKimiToken
// =============================================================================

describe('refreshKimiToken', () => {
    test('returns new tokens on successful refresh', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
                expires_in: 3600,
                token_type: 'Bearer',
                scope: 'openid',
            }),
        });

        const result = await refreshKimiToken('old-refresh', 'device-id-123');

        expect(result.access_token).toBe('new-access-token');
        expect(result.refresh_token).toBe('new-refresh-token');
        expect(result.expires_at).toBeGreaterThan(Date.now());
    });

    test('falls back to original refresh token if new one not provided', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-at',
                expires_in: 3600,
            }),
        });

        const result = await refreshKimiToken('original-rt', 'did');
        expect(result.refresh_token).toBe('original-rt');
    });

    test('uses 7 days default expiry when expires_in not provided', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ access_token: 'at' }),
        });

        const before = Date.now();
        const result = await refreshKimiToken('rt', 'did');
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        expect(result.expires_at).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    });

    test('throws when response is not ok', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        });

        await expect(refreshKimiToken('bad-rt', 'did')).rejects.toThrow('Token refresh failed');
    });

    test('throws when access_token is missing from response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ error: 'invalid_grant', error_description: 'Invalid grant' }),
        });

        // refreshKimiToken checks !access_token, not error field
        await expect(refreshKimiToken('rt', 'did')).rejects.toThrow('Empty access token');
    });

    test('throws when access_token field empty but no error field', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({}), // no access_token, no error
        });

        await expect(refreshKimiToken('rt', 'did')).rejects.toThrow('Empty access token');
    });
});
