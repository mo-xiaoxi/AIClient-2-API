/**
 * Unit tests for auth/copilot-oauth.js
 * Tests: handleCopilotOAuth, refreshCopilotToken
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

let handleCopilotOAuth;
let refreshCopilotToken;

let mockBroadcastEvent;
let mockAutoLinkProviderConfigs;
let mockFsMkdir;
let mockFsWriteFile;
let mockFsChmod;
let originalFetch;

beforeAll(async () => {
    mockBroadcastEvent = jest.fn();
    mockAutoLinkProviderConfigs = jest.fn().mockResolvedValue(undefined);
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);
    mockFsChmod = jest.fn().mockResolvedValue(undefined);

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
                chmod: (...args) => mockFsChmod(...args),
            },
        },
        promises: {
            mkdir: (...args) => mockFsMkdir(...args),
            writeFile: (...args) => mockFsWriteFile(...args),
            chmod: (...args) => mockFsChmod(...args),
        },
    }));

    const mod = await import('../../../src/auth/copilot-oauth.js');
    handleCopilotOAuth = mod.handleCopilotOAuth;
    refreshCopilotToken = mod.refreshCopilotToken;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsChmod.mockResolvedValue(undefined);
    mockAutoLinkProviderConfigs.mockResolvedValue(undefined);
    originalFetch = global.fetch;
    global.fetch = jest.fn();
});

afterEach(() => {
    global.fetch = originalFetch;
});

// =============================================================================
// handleCopilotOAuth
// =============================================================================

describe('handleCopilotOAuth', () => {
    test('returns success with authUrl and userCode on valid device code response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                device_code: 'gh-device-code',
                user_code: 'ABCD-1234',
                verification_uri: 'https://github.com/login/device',
                expires_in: 900,
                interval: 5,
            }),
        });

        const result = await handleCopilotOAuth({});

        expect(result.success).toBe(true);
        expect(result.authUrl).toBe('https://github.com/login/device');
        expect(result.userCode).toBe('ABCD-1234');
        expect(result.authInfo.provider).toBe('openai-copilot-oauth');
        expect(result.authInfo.method).toBe('device-code');
        expect(Array.isArray(result.authInfo.instructions)).toBe(true);
        expect(result.authInfo.instructions.length).toBeGreaterThan(0);
    });

    test('returns failure when device code request fails', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error',
        });

        const result = await handleCopilotOAuth({});

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.authInfo.provider).toBe('openai-copilot-oauth');
    });

    test('returns failure when device code response is invalid JSON', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => 'not-valid-json',
        });

        const result = await handleCopilotOAuth({});

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not valid JSON/);
    });

    test('returns failure when device_code or user_code missing', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ device_code: 'dc' }), // missing user_code
        });

        const result = await handleCopilotOAuth({});
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Invalid device code/);
    });

    test('authInfo contains expiresIn', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                device_code: 'dc',
                user_code: 'UC',
                verification_uri: 'https://github.com/login/device',
                expires_in: 900,
                interval: 5,
            }),
        });

        const result = await handleCopilotOAuth();
        expect(result.authInfo.expiresIn).toBe(900);
    });

    test('works without config argument', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                device_code: 'dc',
                user_code: 'UC',
                verification_uri: 'https://github.com/login/device',
                expires_in: 900,
                interval: 5,
            }),
        });

        const result = await handleCopilotOAuth();
        expect(result.success).toBe(true);
    });
});

// =============================================================================
// refreshCopilotToken
// =============================================================================

describe('refreshCopilotToken', () => {
    test('resolves when token is valid and user info fetched', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ login: 'octocat', email: 'oct@github.com', name: 'Octocat' }),
        });

        await expect(refreshCopilotToken('valid-gh-token')).resolves.toBeUndefined();
    });

    test('throws when accessToken is empty string', async () => {
        await expect(refreshCopilotToken('')).rejects.toThrow('No access token provided');
    });

    test('throws when accessToken is undefined', async () => {
        await expect(refreshCopilotToken(undefined)).rejects.toThrow('No access token provided');
    });

    test('throws when user info fetch fails', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        });

        await expect(refreshCopilotToken('bad-token')).rejects.toThrow('Copilot token validation failed');
    });

    test('throws when login field is missing in user info', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ email: 'x@y.com' }), // missing login
        });

        await expect(refreshCopilotToken('tok')).rejects.toThrow('Copilot token validation failed');
    });
});
