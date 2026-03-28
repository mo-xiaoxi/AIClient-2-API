/**
 * Unit tests for auth/kilo-oauth.js
 * Tests: handleKiloOAuth, refreshKiloToken
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

let handleKiloOAuth;
let refreshKiloToken;

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

    const mod = await import('../../../src/auth/kilo-oauth.js');
    handleKiloOAuth = mod.handleKiloOAuth;
    refreshKiloToken = mod.refreshKiloToken;
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
// handleKiloOAuth
// =============================================================================

describe('handleKiloOAuth', () => {
    test('returns success with authUrl and userCode on valid device code response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 201,
            text: async () => JSON.stringify({
                code: 'test-device-code',
                verificationUrl: 'https://auth.kilo.ai/verify',
                expiresIn: 600,
            }),
        });

        const result = await handleKiloOAuth({});

        expect(result.success).toBe(true);
        expect(result.authUrl).toBe('https://auth.kilo.ai/verify');
        expect(result.userCode).toBe('test-device-code');
        expect(result.authInfo).toBeDefined();
        expect(result.authInfo.provider).toBe('openai-kilo-oauth');
        expect(result.authInfo.method).toBe('device-code');
        expect(Array.isArray(result.authInfo.instructions)).toBe(true);
    });

    test('returns failure when device code request fails', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error',
        });

        const result = await handleKiloOAuth({});

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.authInfo.provider).toBe('openai-kilo-oauth');
    });

    test('returns failure when device code response is invalid JSON', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => 'not-json',
        });

        const result = await handleKiloOAuth({});

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not valid JSON/);
    });

    test('returns failure when device code response missing required fields', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 'abc' }), // missing verificationUrl
        });

        const result = await handleKiloOAuth({});

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Invalid device code response/);
    });

    test('authInfo includes verificationUrl and expiresIn', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                code: 'abc123',
                verificationUrl: 'https://kilo.ai/verify',
                expiresIn: 900,
            }),
        });

        const result = await handleKiloOAuth();

        expect(result.success).toBe(true);
        expect(result.authInfo.verificationUrl).toBe('https://kilo.ai/verify');
        expect(result.authInfo.expiresIn).toBe(900);
    });
});

// =============================================================================
// refreshKiloToken
// =============================================================================

describe('refreshKiloToken', () => {
    test('resolves when profile fetch succeeds', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ email: 'user@kilo.ai', organizations: [] }),
        });

        await expect(refreshKiloToken('valid-token')).resolves.toBeUndefined();
    });

    test('throws when accessToken is empty', async () => {
        await expect(refreshKiloToken('')).rejects.toThrow('No access token provided');
    });

    test('throws when accessToken is null/undefined', async () => {
        await expect(refreshKiloToken(null)).rejects.toThrow('No access token provided');
    });

    test('throws when profile fetch fails', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        });

        await expect(refreshKiloToken('bad-token')).rejects.toThrow('Kilo token validation failed');
    });
});
