/**
 * Unit tests for src/providers/openai/qwen-core.js — errors, QwenApiService helpers.
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn((c) => c),
}));

await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    isRetryableNetworkError: jest.fn(() => false),
    MODEL_PROVIDER: { QWEN_API: 'openai-qwen-oauth' },
    formatExpiryLog: jest.fn(() => ({ message: 'ok', isNearExpiry: false })),
}));

await jest.unstable_mockModule('../../../src/auth/oauth-handlers.js', () => ({
    handleQwenOAuth: jest.fn(),
}));

await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['qwen3-coder', 'qwen-turbo']),
}));

const mockAxiosCreate = jest.fn(() => ({ request: jest.fn().mockResolvedValue({ data: {} }) }));
await jest.unstable_mockModule('axios', () => ({
    default: {
        create: mockAxiosCreate,
        request: jest.fn(),
    },
}));

let TokenManagerError;
let CredentialsClearRequiredError;
let QwenApiService;

beforeAll(async () => {
    const mod = await import('../../../src/providers/openai/qwen-core.js');
    TokenManagerError = mod.TokenManagerError;
    CredentialsClearRequiredError = mod.CredentialsClearRequiredError;
    QwenApiService = mod.QwenApiService;
});

beforeEach(() => {
    jest.clearAllMocks();
});

function makeService(overrides = {}) {
    return new QwenApiService({
        uuid: 'test-uuid',
        QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        ...overrides,
    });
}

describe('TokenManagerError / CredentialsClearRequiredError', () => {
    test('TokenManagerError carries type and originalError', () => {
        const inner = new Error('inner');
        const e = new TokenManagerError('REFRESH_FAILED', 'msg', inner);
        expect(e.type).toBe('REFRESH_FAILED');
        expect(e.originalError).toBe(inner);
        expect(e.name).toBe('TokenManagerError');
    });

    test('CredentialsClearRequiredError wraps original', () => {
        const inner = new Error('400');
        const e = new CredentialsClearRequiredError('clear', inner);
        expect(e.originalError).toBe(inner);
        expect(e.name).toBe('CredentialsClearRequiredError');
    });
});

describe('QwenApiService', () => {
    test('constructor sets baseUrl and uuid', () => {
        const svc = makeService();
        expect(svc.baseUrl).toContain('dashscope');
        expect(svc.uuid).toBe('test-uuid');
    });

    test('getCurrentEndpoint appends /v1 when missing', () => {
        const svc = makeService();
        expect(svc.getCurrentEndpoint('https://example.com')).toBe('https://example.com/v1');
        expect(svc.getCurrentEndpoint('https://example.com/v1')).toBe('https://example.com/v1');
    });

    test('getCurrentEndpoint adds https for host without scheme', () => {
        const svc = makeService();
        expect(svc.getCurrentEndpoint('api.example.com')).toBe('https://api.example.com/v1');
    });

    test('isAuthError detects 401/403 and message keywords', () => {
        const svc = makeService();
        expect(svc.isAuthError({ status: 401 })).toBe(true);
        expect(svc.isAuthError({ response: { status: 403 } })).toBe(true);
        expect(svc.isAuthError(new Error('Unauthorized access'))).toBe(true);
        expect(svc.isAuthError(new Error('ok'))).toBe(false);
    });

    test('processMessageContent flattens array content to string', () => {
        const svc = makeService();
        const out = svc.processMessageContent({
            messages: [
                { role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
            ],
        });
        expect(out.messages[0].content).toBe('a\nb');
    });

    test('processMessageContent returns original when no messages', () => {
        const svc = makeService();
        expect(svc.processMessageContent(null)).toBeNull();
        expect(svc.processMessageContent({})).toEqual({});
    });

    test('listModels returns data from QWEN_MODEL_LIST', async () => {
        const svc = makeService();
        const res = await svc.listModels();
        expect(res.data).toBeDefined();
        expect(Array.isArray(res.data)).toBe(true);
        expect(res.data.length).toBeGreaterThan(0);
    });

    test('isExpiryDateNear returns false when no credentials', () => {
        const svc = makeService();
        svc.qwenClient.setCredentials(null);
        expect(svc.isExpiryDateNear()).toBe(false);
    });
});
