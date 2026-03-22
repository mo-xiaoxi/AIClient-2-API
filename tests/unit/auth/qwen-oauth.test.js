/**
 * Unit tests for qwen-oauth.js
 *
 * Tests: handleQwenOAuth — device code flow initiation and background polling
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';

let handleQwenOAuth;

let mockBroadcastEvent;
let mockAutoLinkProviderConfigs;
let mockAxios;

beforeAll(async () => {
    mockBroadcastEvent = jest.fn();
    mockAutoLinkProviderConfigs = jest.fn().mockResolvedValue(undefined);

    // Default axios mock: simulates a successful device-code response
    mockAxios = jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
            device_code: 'mock-device-code-12345',
            user_code: 'MOCK-CODE',
            verification_uri: 'https://chat.qwen.ai/device',
            verification_uri_complete: 'https://chat.qwen.ai/device?user_code=MOCK-CODE',
            expires_in: 300,
            interval: 5,
        },
        headers: {},
    });
    mockAxios.create = jest.fn().mockReturnValue(mockAxios);

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

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        getProxyConfigForProvider: jest.fn().mockReturnValue(null),
    }));

    await jest.unstable_mockModule('axios', () => ({
        __esModule: true,
        default: mockAxios,
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        default: {
            promises: {
                mkdir: jest.fn().mockResolvedValue(undefined),
                writeFile: jest.fn().mockResolvedValue(undefined),
            },
        },
        promises: {
            mkdir: jest.fn().mockResolvedValue(undefined),
            writeFile: jest.fn().mockResolvedValue(undefined),
        },
    }));

    const mod = await import('../../../src/auth/qwen-oauth.js');
    handleQwenOAuth = mod.handleQwenOAuth;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockBroadcastEvent.mockReset();
    mockAutoLinkProviderConfigs.mockResolvedValue(undefined);

    // Restore default device-code response
    mockAxios.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
            device_code: 'mock-device-code-12345',
            user_code: 'MOCK-CODE',
            verification_uri: 'https://chat.qwen.ai/device',
            verification_uri_complete: 'https://chat.qwen.ai/device?user_code=MOCK-CODE',
            expires_in: 300,
            interval: 5,
        },
        headers: {},
    });
});

// =============================================================================
// handleQwenOAuth
// =============================================================================

describe('handleQwenOAuth', () => {
    test('returns authUrl and authInfo on success', async () => {
        const result = await handleQwenOAuth({});
        expect(result.authUrl).toBeDefined();
        expect(typeof result.authUrl).toBe('string');
        expect(result.authInfo).toBeDefined();
    });

    test('authUrl equals verification_uri_complete from device response', async () => {
        const result = await handleQwenOAuth({});
        expect(result.authUrl).toBe('https://chat.qwen.ai/device?user_code=MOCK-CODE');
    });

    test('authInfo contains provider openai-qwen-oauth', async () => {
        const result = await handleQwenOAuth({});
        expect(result.authInfo.provider).toBe('openai-qwen-oauth');
    });

    test('authInfo contains deviceCode field', async () => {
        const result = await handleQwenOAuth({});
        expect(result.authInfo.deviceCode).toBeDefined();
    });

    test('throws when API request fails', async () => {
        mockAxios.mockResolvedValue({
            status: 400,
            statusText: 'Bad Request',
            data: {},
            headers: {},
        });

        await expect(handleQwenOAuth({})).rejects.toThrow();
    });

    test('throws when response is missing required fields', async () => {
        mockAxios.mockResolvedValue({
            status: 200,
            statusText: 'OK',
            data: {}, // missing device_code and verification_uri_complete
            headers: {},
        });

        await expect(handleQwenOAuth({})).rejects.toThrow();
    });

    test('starts background polling without blocking return', async () => {
        const start = Date.now();
        // The background poll will attempt to exchange token but fail since
        // we don't mock the second call — that's fire-and-forget.
        const result = await handleQwenOAuth({});
        const elapsed = Date.now() - start;
        // Should return quickly (not wait for polling)
        expect(elapsed).toBeLessThan(1000);
        expect(result.authUrl).toBeDefined();
    });
});
