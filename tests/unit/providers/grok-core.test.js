/**
 * Unit tests for src/providers/grok/grok-core.js
 *
 * Tests: GrokApiService construction, initialize, buildHeaders,
 *        generateContent, generateContentStream, isExpiryDateNear.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAxios = jest.fn();

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn((cfg) => cfg),
    getProxyConfigForProvider: jest.fn(() => null),
    getGoogleAuthProxyConfig: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    isRetryableNetworkError: jest.fn(() => false),
    MODEL_PROVIDER: { GROK_CUSTOM: 'grok-custom' },
    MODEL_PROTOCOL_PREFIX: { GROK: 'grok' },
}));

await jest.unstable_mockModule('../../../src/converters/ConverterFactory.js', () => ({
    ConverterFactory: {
        getConverter: jest.fn(() => ({
            setUuid: jest.fn(),
            formatToolHistory: jest.fn((m) => m),
            buildToolPrompt: jest.fn(() => ''),
            buildToolOverrides: jest.fn(() => ({})),
        })),
    },
}));

await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

// Mock uuid module
await jest.unstable_mockModule('uuid', () => ({
    v4: jest.fn(() => 'mock-uuid-1234'),
}));

// Mock axios as a callable function with static methods
const mockAxiosObj = Object.assign(mockAxios, {
    request: jest.fn(),
    create: jest.fn(() => ({ request: jest.fn() })),
});

await jest.unstable_mockModule('axios', () => ({
    default: mockAxiosObj,
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

let GrokApiService;

beforeAll(async () => {
    const mod = await import('../../../src/providers/grok/grok-core.js');
    GrokApiService = mod.GrokApiService;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides = {}) {
    return new GrokApiService({
        GROK_COOKIE_TOKEN: 'sso=test-token',
        GROK_BASE_URL: 'https://grok.com',
        uuid: 'test-uuid',
        REQUEST_MAX_RETRIES: 0,
        ...overrides,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GrokApiService — construction', () => {
    test('constructs with required config', () => {
        const svc = makeService();
        expect(svc).toBeDefined();
        expect(svc.token).toBe('sso=test-token');
        expect(svc.baseUrl).toBe('https://grok.com');
        expect(svc.isInitialized).toBe(false);
    });

    test('uses default base URL when not specified', () => {
        const svc = new GrokApiService({ GROK_COOKIE_TOKEN: 't', uuid: 'u' });
        expect(svc.baseUrl).toBe('https://grok.com');
    });

    test('uses provided user agent', () => {
        const svc = makeService({ GROK_USER_AGENT: 'CustomAgent/1.0' });
        expect(svc.userAgent).toBe('CustomAgent/1.0');
    });

    test('chatApi is derived from baseUrl', () => {
        const svc = makeService({ GROK_BASE_URL: 'https://custom.grok.com' });
        expect(svc.chatApi).toBe('https://custom.grok.com/rest/app-chat/conversations/new');
    });
});

describe('GrokApiService — initialize', () => {
    beforeEach(() => mockAxios.mockReset());

    test('sets isInitialized to true', async () => {
        const svc = makeService();
        expect(svc.isInitialized).toBe(false);
        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
    });

    test('calling initialize twice does not reset state', async () => {
        const svc = makeService();
        await svc.initialize();
        svc._testProp = 'hello';
        await svc.initialize(); // second call — should be no-op
        expect(svc._testProp).toBe('hello');
    });
});

describe('GrokApiService — buildHeaders', () => {
    test('returns object with expected keys', () => {
        const svc = makeService();
        const h = svc.buildHeaders();
        expect(h).toHaveProperty('accept');
        expect(h).toHaveProperty('content-type');
        expect(h).toHaveProperty('user-agent');
        expect(h).toHaveProperty('cookie');
    });

    test('includes SSO token in cookie', () => {
        const svc = makeService({ GROK_COOKIE_TOKEN: 'sso=my-sso-token' });
        const h = svc.buildHeaders();
        expect(h.cookie).toContain('sso=my-sso-token');
    });

    test('strips leading "sso=" prefix from token in cookie', () => {
        const svc = makeService({ GROK_COOKIE_TOKEN: 'sso=abc123' });
        const h = svc.buildHeaders();
        // Should appear as sso=abc123 (without duplicate "sso=sso=" prefix)
        expect(h.cookie).toMatch(/sso=abc123/);
        expect(h.cookie).not.toContain('sso=sso=');
    });

    test('includes cf_clearance when cfClearance is set', () => {
        const svc = makeService({ GROK_CF_CLEARANCE: 'clearance-value' });
        const h = svc.buildHeaders();
        expect(h.cookie).toContain('cf_clearance=clearance-value');
    });

    test('x-xai-request-id is present', () => {
        const svc = makeService();
        const h = svc.buildHeaders();
        expect(h['x-xai-request-id']).toBeDefined();
    });
});

describe('GrokApiService — isExpiryDateNear', () => {
    test('returns true when lastSyncAt is null', () => {
        const svc = makeService();
        expect(svc.isExpiryDateNear()).toBe(true);
    });

    test('returns false shortly after sync', () => {
        const svc = makeService({ CRON_NEAR_MINUTES: 15 });
        svc.lastSyncAt = Date.now();
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('returns true when lastSyncAt is stale', () => {
        const svc = makeService({ CRON_NEAR_MINUTES: 1 });
        svc.lastSyncAt = Date.now() - 2 * 60 * 1000; // 2 minutes ago
        expect(svc.isExpiryDateNear()).toBe(true);
    });
});

describe('GrokApiService — classifyApiError', () => {
    test('marks 401 as shouldSwitchCredential', () => {
        const svc = makeService();
        const err = { response: { status: 401 }, message: '' };
        svc.classifyApiError(err);
        expect(err.shouldSwitchCredential).toBe(true);
    });

    test('marks 403 as shouldSwitchCredential', () => {
        const svc = makeService();
        const err = { response: { status: 403 }, message: '' };
        svc.classifyApiError(err);
        expect(err.shouldSwitchCredential).toBe(true);
    });
});

describe('GrokApiService — getMaxRequestRetries', () => {
    test('returns 3 when config has no value', () => {
        const svc = makeService({ REQUEST_MAX_RETRIES: undefined });
        expect(svc.getMaxRequestRetries()).toBe(3);
    });

    test('returns configured value when positive integer', () => {
        const svc = makeService({ REQUEST_MAX_RETRIES: '5' });
        expect(svc.getMaxRequestRetries()).toBe(5);
    });

    test('returns 3 for zero or negative value', () => {
        const svc = makeService({ REQUEST_MAX_RETRIES: '0' });
        expect(svc.getMaxRequestRetries()).toBe(3);
    });
});
