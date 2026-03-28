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

    test('_getQwenCachedCredentialPath uses custom path when configured', () => {
        const svc = makeService({ QWEN_OAUTH_CREDS_FILE_PATH: '/custom/path/creds.json' });
        const result = svc._getQwenCachedCredentialPath();
        expect(result).toContain('creds.json');
    });

    test('_getQwenCachedCredentialPath uses default home dir when no custom path', () => {
        const svc = makeService();
        const result = svc._getQwenCachedCredentialPath();
        expect(result).toContain('.qwen');
        expect(result).toContain('oauth_creds.json');
    });
});

describe('QwenApiService — initialize()', () => {
    test('sets isInitialized to true', async () => {
        const svc = makeService();
        expect(svc.isInitialized).toBe(false);

        // Spy on loadCredentials to skip actual file I/O
        svc.loadCredentials = jest.fn().mockResolvedValue(undefined);

        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
        expect(svc.loadCredentials).toHaveBeenCalledTimes(1);
    });

    test('is idempotent (second call is no-op)', async () => {
        const svc = makeService();
        svc.loadCredentials = jest.fn().mockResolvedValue(undefined);

        await svc.initialize();
        await svc.initialize();

        expect(svc.loadCredentials).toHaveBeenCalledTimes(1);
    });

    test('creates currentAxiosInstance after initialization', async () => {
        const svc = makeService();
        svc.loadCredentials = jest.fn().mockResolvedValue(undefined);

        await svc.initialize();
        expect(svc.currentAxiosInstance).toBeDefined();
    });
});

describe('QwenApiService — generateContent()', () => {
    test('delegates to callApiWithAuthAndRetry', async () => {
        const svc = makeService();
        svc.callApiWithAuthAndRetry = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'hi' } }] });

        const result = await svc.generateContent('qwen3-coder', {
            messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(svc.callApiWithAuthAndRetry).toHaveBeenCalledWith('/chat/completions', expect.any(Object), false);
        expect(result).toBeDefined();
    });

    test('removes _monitorRequestId from body', async () => {
        const svc = makeService();
        svc.callApiWithAuthAndRetry = jest.fn().mockResolvedValue({});

        const body = { messages: [], _monitorRequestId: 'req-123' };
        await svc.generateContent('qwen3-coder', body);

        expect(body._monitorRequestId).toBeUndefined();
    });
});

describe('QwenApiService — generateContentStream()', () => {
    test('delegates to callApiWithAuthAndRetry with stream=true', async () => {
        const svc = makeService();

        const data = `data: ${JSON.stringify({ id: 'x' })}\n\ndata: [DONE]\n\n`;
        async function* makeAsyncIter() {
            yield Buffer.from(data);
        }
        svc.callApiWithAuthAndRetry = jest.fn().mockResolvedValue(makeAsyncIter());

        const chunks = [];
        for await (const chunk of svc.generateContentStream('qwen3-coder', { messages: [] })) {
            chunks.push(chunk);
        }

        expect(svc.callApiWithAuthAndRetry).toHaveBeenCalledWith('/chat/completions', expect.any(Object), true);
        expect(chunks.length).toBe(1);
        expect(chunks[0].id).toBe('x');
    });

    test('removes _requestBaseUrl from body', async () => {
        const svc = makeService();
        async function* emptyStream() {}
        svc.callApiWithAuthAndRetry = jest.fn().mockResolvedValue(emptyStream());

        const body = { messages: [], _requestBaseUrl: 'http://example.com' };
        for await (const _ of svc.generateContentStream('qwen3-coder', body)) { /* drain */ }

        expect(body._requestBaseUrl).toBeUndefined();
    });
});

describe('QwenApiService — callApiWithAuthAndRetry() error handling', () => {
    test('marks credential unhealthy on auth error and throws', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        const mockPool = { markProviderNeedRefresh: jest.fn() };
        getProviderPoolManager.mockReturnValue(mockPool);

        const svc = makeService({ uuid: 'qwen-uuid' });
        const authError = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
        svc.getValidToken = jest.fn().mockRejectedValue(authError);

        await expect(svc.callApiWithAuthAndRetry('/chat/completions', {}, false))
            .rejects.toThrow();
    });

    test('returns data on success', async () => {
        const svc = makeService();
        const mockRequest = jest.fn().mockResolvedValue({ data: { choices: [] } });
        const { default: axiosMock } = await import('axios');
        axiosMock.create.mockReturnValueOnce({ request: mockRequest });

        svc.getValidToken = jest.fn().mockResolvedValue({
            token: 'test-token',
            endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        });

        const result = await svc.callApiWithAuthAndRetry('/chat/completions', { model: 'qwen-turbo', messages: [] });
        expect(result).toBeDefined();
    });
});
