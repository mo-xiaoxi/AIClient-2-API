/**
 * Unit tests for auth/oauth-handlers.js (re-export barrel)
 *
 * Verifies that the barrel module correctly re-exports all functions
 * from the individual provider OAuth modules.
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

let oauthHandlers;

beforeAll(async () => {
    // Mock all dependencies so we can import the barrel without side effects

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
        __esModule: true,
        broadcastEvent: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        __esModule: true,
        autoLinkProviderConfigs: jest.fn().mockResolvedValue(undefined),
    }));

    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        __esModule: true,
        CONFIG: {},
    }));

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        getProxyConfigForProvider: jest.fn().mockReturnValue(null),
        getGoogleAuthProxyConfig: jest.fn().mockReturnValue(null),
    }));

    await jest.unstable_mockModule('google-auth-library', () => ({
        __esModule: true,
        OAuth2Client: jest.fn().mockImplementation(() => ({
            redirectUri: null,
            generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/mock'),
            getToken: jest.fn().mockResolvedValue({ tokens: {} }),
        })),
    }));

    await jest.unstable_mockModule('axios', () => {
        const fn = jest.fn().mockResolvedValue({ status: 200, data: {}, headers: {} });
        fn.create = jest.fn().mockReturnValue(fn);
        return { __esModule: true, default: fn };
    });

    await jest.unstable_mockModule('open', () => ({
        __esModule: true,
        default: jest.fn().mockResolvedValue(undefined),
    }));

    await jest.unstable_mockModule('http', () => ({
        __esModule: true,
        default: {
            createServer: jest.fn().mockReturnValue({
                listen: jest.fn(function (p, h, cb) { if (cb) cb(); }),
                close: jest.fn(function (cb) { if (cb) cb(); }),
                on: jest.fn(),
                listening: true,
            }),
        },
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        default: {
            existsSync: jest.fn().mockReturnValue(false),
            promises: {
                mkdir: jest.fn().mockResolvedValue(undefined),
                writeFile: jest.fn().mockResolvedValue(undefined),
                readdir: jest.fn().mockResolvedValue([]),
                readFile: jest.fn().mockResolvedValue('{}'),
            },
        },
        existsSync: jest.fn().mockReturnValue(false),
        promises: {
            mkdir: jest.fn().mockResolvedValue(undefined),
            writeFile: jest.fn().mockResolvedValue(undefined),
            readdir: jest.fn().mockResolvedValue([]),
            readFile: jest.fn().mockResolvedValue('{}'),
        },
    }));

    // iFlow OAuth mock — the barrel imports it
    await jest.unstable_mockModule('../../../src/auth/iflow-oauth.js', () => ({
        __esModule: true,
        handleIFlowOAuth: jest.fn(),
        refreshIFlowTokens: jest.fn(),
    }));

    oauthHandlers = await import('../../../src/auth/oauth-handlers.js');
});

// =============================================================================
// Barrel re-export verification
// =============================================================================

describe('oauth-handlers barrel re-exports', () => {
    test('exports handleCodexOAuth function', () => {
        expect(typeof oauthHandlers.handleCodexOAuth).toBe('function');
    });

    test('exports handleCodexOAuthCallback function', () => {
        expect(typeof oauthHandlers.handleCodexOAuthCallback).toBe('function');
    });

    test('exports batchImportCodexTokensStream function', () => {
        expect(typeof oauthHandlers.batchImportCodexTokensStream).toBe('function');
    });

    test('exports handleGeminiCliOAuth function', () => {
        expect(typeof oauthHandlers.handleGeminiCliOAuth).toBe('function');
    });

    test('exports handleGeminiAntigravityOAuth function', () => {
        expect(typeof oauthHandlers.handleGeminiAntigravityOAuth).toBe('function');
    });

    test('exports batchImportGeminiTokensStream function', () => {
        expect(typeof oauthHandlers.batchImportGeminiTokensStream).toBe('function');
    });

    test('exports checkGeminiCredentialsDuplicate function', () => {
        expect(typeof oauthHandlers.checkGeminiCredentialsDuplicate).toBe('function');
    });

    test('exports handleQwenOAuth function', () => {
        expect(typeof oauthHandlers.handleQwenOAuth).toBe('function');
    });

    test('exports handleKiroOAuth function', () => {
        expect(typeof oauthHandlers.handleKiroOAuth).toBe('function');
    });

    test('exports handleCursorOAuth function', () => {
        expect(typeof oauthHandlers.handleCursorOAuth).toBe('function');
    });

    test('exports generateCursorAuthParams function', () => {
        expect(typeof oauthHandlers.generateCursorAuthParams).toBe('function');
    });

    test('exports refreshCursorToken function', () => {
        expect(typeof oauthHandlers.refreshCursorToken).toBe('function');
    });

    test('exports handleIFlowOAuth function', () => {
        expect(typeof oauthHandlers.handleIFlowOAuth).toBe('function');
    });

    test('exports refreshIFlowTokens function', () => {
        expect(typeof oauthHandlers.refreshIFlowTokens).toBe('function');
    });
});
