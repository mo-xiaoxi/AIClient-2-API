/**
 * Unit tests for auth/codebuddy-oauth.js
 * Tests: handleCodeBuddyOAuth, refreshCodeBuddyToken
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

let handleCodeBuddyOAuth;
let refreshCodeBuddyToken;

let mockBroadcastEvent;
let mockAutoLinkProviderConfigs;
let mockFsMkdir;
let mockFsWriteFile;
let originalFetch;

beforeAll(async () => {
    mockBroadcastEvent = jest.fn();
    mockAutoLinkProviderConfigs = jest.fn().mockResolvedValue(undefined);
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
        __esModule: true,
        broadcastEvent: mockBroadcastEvent,
    }));

    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        __esModule: true,
        autoLinkProviderConfigs: mockAutoLinkProviderConfigs,
    }));

    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        __esModule: true,
        CONFIG: {},
    }));

    await jest.unstable_mockModule('node:fs', () => ({
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

    const mod = await import('../../../src/auth/codebuddy-oauth.js');
    handleCodeBuddyOAuth = mod.handleCodeBuddyOAuth;
    refreshCodeBuddyToken = mod.refreshCodeBuddyToken;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockAutoLinkProviderConfigs.mockResolvedValue(undefined);
    originalFetch = global.fetch;
    global.fetch = jest.fn();
});

afterEach(() => {
    global.fetch = originalFetch;
});

// =============================================================================
// handleCodeBuddyOAuth
// =============================================================================

describe('handleCodeBuddyOAuth', () => {
    test('returns authUrl and authInfo on valid state response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 0,
                data: {
                    state: 'state-abc123',
                    authUrl: 'https://copilot.tencent.com/auth?state=abc123',
                },
            }),
        });

        const result = await handleCodeBuddyOAuth({});

        expect(result.authUrl).toBe('https://copilot.tencent.com/auth?state=abc123');
        expect(result.authInfo).toBeDefined();
        expect(result.authInfo.provider).toBe('openai-codebuddy-oauth');
        expect(result.authInfo.state).toBe('state-abc123');
    });

    test('throws when auth state request fails (non-ok HTTP)', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 502,
            text: async () => 'Bad Gateway',
        });

        await expect(handleCodeBuddyOAuth({})).rejects.toThrow('Auth state request failed');
    });

    test('throws when code is not CODE_SUCCESS', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 11001,
                msg: 'Parameter error',
            }),
        });

        await expect(handleCodeBuddyOAuth({})).rejects.toThrow('Auth state error');
    });

    test('throws when state or authUrl missing from data', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 0,
                data: { state: 'state-only' }, // missing authUrl
            }),
        });

        await expect(handleCodeBuddyOAuth({})).rejects.toThrow('missing state or authUrl');
    });

    test('authInfo contains pollIntervalMs and maxPollDurationMs', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 0,
                data: { state: 's', authUrl: 'https://url' },
            }),
        });

        const result = await handleCodeBuddyOAuth();
        expect(result.authInfo.pollIntervalMs).toBeDefined();
        expect(result.authInfo.maxPollDurationMs).toBeDefined();
    });
});

// =============================================================================
// refreshCodeBuddyToken
// =============================================================================

describe('refreshCodeBuddyToken', () => {
    test('returns new token data on successful refresh', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 0,
                data: {
                    accessToken: 'new-at',
                    refreshToken: 'new-rt',
                    expiresIn: 2592000,
                    domain: 'www.codebuddy.cn',
                },
            }),
        });

        const result = await refreshCodeBuddyToken('old-at', 'old-rt', 'user123', 'www.codebuddy.cn');

        expect(result.access_token).toBe('new-at');
        expect(result.refresh_token).toBe('new-rt');
        expect(result.type).toBe('codebuddy');
        expect(result.expires_at).toBeGreaterThan(Date.now());
    });

    test('falls back to original refresh token if new one not provided', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 0,
                data: { accessToken: 'new-at', expiresIn: 3600 },
            }),
        });

        const result = await refreshCodeBuddyToken('old-at', 'original-rt', 'uid', 'dom');
        expect(result.refresh_token).toBe('original-rt');
    });

    test('uses default domain when not provided', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 0,
                data: { accessToken: 'at', expiresIn: 3600 },
            }),
        });

        const result = await refreshCodeBuddyToken('at', 'rt', 'uid');
        expect(result.domain).toBe('www.codebuddy.cn');
    });

    test('throws on 401 response', async () => {
        global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
        await expect(refreshCodeBuddyToken('at', 'rt', 'uid')).rejects.toThrow('Refresh token rejected');
    });

    test('throws on 403 response', async () => {
        global.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
        await expect(refreshCodeBuddyToken('at', 'rt', 'uid')).rejects.toThrow('Refresh token rejected');
    });

    test('throws when response code is not success', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ code: 11001, msg: 'Token expired' }),
        });

        await expect(refreshCodeBuddyToken('at', 'rt', 'uid')).rejects.toThrow('Token refresh error');
    });

    test('throws when data is empty in response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ code: 0, data: null }),
        });

        await expect(refreshCodeBuddyToken('at', 'rt', 'uid')).rejects.toThrow('Empty data in refresh response');
    });

    test('throws on non-ok, non-401/403 response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => 'Server Error',
        });

        await expect(refreshCodeBuddyToken('at', 'rt', 'uid')).rejects.toThrow('Token refresh failed');
    });
});

// =============================================================================
// JWT helper (decodeUserIdFromJWT) via refreshCodeBuddyToken
// =============================================================================

describe('JWT decode (via refreshCodeBuddyToken)', () => {
    test('extracts sub from valid JWT in accessToken', async () => {
        // Build a minimal JWT with sub claim
        const payload = Buffer.from(JSON.stringify({ sub: 'user-id-from-jwt' })).toString('base64url');
        const fakeJwt = `header.${payload}.sig`;

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 0,
                data: { accessToken: fakeJwt, expiresIn: 3600 },
            }),
        });

        const result = await refreshCodeBuddyToken('old', 'rt', 'fallback-uid');
        expect(result.user_id).toBe('user-id-from-jwt');
    });

    test('falls back to provided userId when JWT is malformed', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                code: 0,
                data: { accessToken: 'not.a.jwt', expiresIn: 3600 },
            }),
        });

        const result = await refreshCodeBuddyToken('old', 'rt', 'fallback-uid');
        expect(result.user_id).toBe('fallback-uid');
    });
});
