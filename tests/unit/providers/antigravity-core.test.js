/**
 * Unit tests for src/providers/gemini/antigravity-core.js
 * Focus: AntigravityApiService construction, URL fallback, token expiry check.
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const mockOAuthCtor = jest.fn();

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn((opts) => opts),
    getProxyConfigForProvider: jest.fn(() => null),
    getGoogleAuthProxyConfig: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['gemini-3-flash', 'claude-thinking']),
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    formatExpiryTime: jest.fn(),
    isRetryableNetworkError: jest.fn(() => false),
    formatExpiryLog: jest.fn(() => ({ message: '', isNearExpiry: false })),
    MODEL_PROVIDER: { ANTIGRAVITY: 'gemini-antigravity' },
}));

await jest.unstable_mockModule('google-auth-library', () => ({
    OAuth2Client: mockOAuthCtor,
}));

await jest.unstable_mockModule('../../../src/auth/oauth-handlers.js', () => ({
    handleGeminiAntigravityOAuth: jest.fn(),
}));

await jest.unstable_mockModule('open', () => ({
    default: jest.fn().mockResolvedValue(null),
}));

await jest.unstable_mockModule('fs', () => ({
    promises: {
        readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        writeFile: jest.fn(),
        mkdir: jest.fn(),
    },
}));

let AntigravityApiService;

beforeAll(async () => {
    mockOAuthCtor.mockImplementation(() => {
        const inst = {
            credentials: {},
            setCredentials(creds) {
                Object.assign(inst.credentials, creds);
            },
            request: jest.fn().mockResolvedValue({ data: { models: {} } }),
            refreshAccessToken: jest.fn().mockResolvedValue({
                credentials: { access_token: 'new-at', refresh_token: 'rt' },
            }),
        };
        return inst;
    });
    ({ AntigravityApiService } = await import('../../../src/providers/gemini/antigravity-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    mockOAuthCtor.mockImplementation(() => {
        const inst = {
            credentials: {},
            setCredentials(creds) {
                Object.assign(inst.credentials, creds);
            },
            request: jest.fn().mockResolvedValue({ data: { models: {} } }),
            refreshAccessToken: jest.fn().mockResolvedValue({
                credentials: { access_token: 'new-at', refresh_token: 'rt' },
            }),
        };
        return inst;
    });
});

function makeConfig(overrides = {}) {
    return {
        HOST: '127.0.0.1',
        uuid: 'test-uuid',
        PROJECT_ID: 'proj-fixed',
        ...overrides,
    };
}

describe('AntigravityApiService', () => {
    test('constructs OAuth2Client and sets base URL fallback order', () => {
        const svc = new AntigravityApiService(makeConfig());
        expect(mockOAuthCtor).toHaveBeenCalled();
        expect(Array.isArray(svc.baseURLs)).toBe(true);
        expect(svc.baseURLs.length).toBeGreaterThan(0);
    });

    test('getBaseURLFallbackOrder uses only custom ANTIGRAVITY_BASE_URL (trailing slash stripped)', () => {
        const svc = new AntigravityApiService(
            makeConfig({ ANTIGRAVITY_BASE_URL: 'https://custom.example.com/path/' }),
        );
        expect(svc.getBaseURLFallbackOrder({ ANTIGRAVITY_BASE_URL: 'https://custom.example.com/path/' })).toEqual([
            'https://custom.example.com/path',
        ]);
    });

    test('getBaseURLFallbackOrder returns default chain when no custom URL', () => {
        const svc = new AntigravityApiService(makeConfig());
        const order = svc.getBaseURLFallbackOrder({});
        expect(order.every((u) => u.startsWith('https://'))).toBe(true);
        expect(order.length).toBe(3);
    });

    test('isTokenExpiringSoon returns false when expiry_date missing', () => {
        const svc = new AntigravityApiService(makeConfig());
        expect(svc.isTokenExpiringSoon()).toBe(false);
    });

    test('isTokenExpiringSoon returns true when expiry within refresh skew window', () => {
        const svc = new AntigravityApiService(makeConfig());
        // REFRESH_SKEW is 3000s — treat token as expiring if expiry <= now + skew
        svc.authClient.credentials.expiry_date = Date.now() + 60 * 1000;
        expect(svc.isTokenExpiringSoon()).toBe(true);
    });

    test('isTokenExpiringSoon returns false when expiry far in future', () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.authClient.credentials.expiry_date = Date.now() + 365 * 24 * 60 * 60 * 1000;
        expect(svc.isTokenExpiringSoon()).toBe(false);
    });

    test('_applySidecar delegates to configureTLSSidecar', async () => {
        const { configureTLSSidecar } = await import('../../../src/utils/proxy-utils.js');
        const svc = new AntigravityApiService(makeConfig());
        const opts = { url: 'https://x' };
        svc._applySidecar(opts);
        expect(configureTLSSidecar).toHaveBeenCalled();
    });
});
