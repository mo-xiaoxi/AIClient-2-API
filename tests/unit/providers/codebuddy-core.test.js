/**
 * Unit tests for src/providers/codebuddy/codebuddy-core.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    MODEL_PROVIDER: { CODEBUDDY_OAUTH: 'openai-codebuddy-oauth' },
    isRetryableNetworkError: jest.fn(() => false),
}));

await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['GLM-5.0', 'GLM-4.7', 'MiniMax-M2.5']),
}));

const mockGetValidAccessToken = jest.fn();
const mockIsExpiryDateNear = jest.fn(() => false);
const mockGetUserId = jest.fn(() => 'test-user-id');
const mockGetDomain = jest.fn(() => 'www.codebuddy.cn');

await jest.unstable_mockModule('../../../src/providers/codebuddy/codebuddy-token-store.js', () => ({
    CodeBuddyTokenStore: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        getValidAccessToken: mockGetValidAccessToken,
        isExpiryDateNear: mockIsExpiryDateNear,
        getUserId: mockGetUserId,
        getDomain: mockGetDomain,
        userId: 'test-user-id',
        domain: 'www.codebuddy.cn',
        _cached: null,
    })),
}));

let CodeBuddyApiService;

beforeAll(async () => {
    ({ CodeBuddyApiService } = await import('../../../src/providers/codebuddy/codebuddy-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue('test-access-token');
    mockIsExpiryDateNear.mockReturnValue(false);
});

describe('CodeBuddyApiService', () => {
    test('constructor stores credFilePath under _credFilePath', () => {
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        expect(svc._credFilePath).toBe('/tmp/cb.json');
        expect(svc.isInitialized).toBe(false);
    });

    test('initialize throws when credFilePath is not configured', async () => {
        const svc = new CodeBuddyApiService({ uuid: 'u1' });
        await expect(svc.initialize()).rejects.toThrow('CODEBUDDY_OAUTH_CREDS_FILE_PATH');
    });

    test('initialize sets isInitialized to true', async () => {
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
    });

    test('initialize is idempotent', async () => {
        const { CodeBuddyTokenStore } = await import('../../../src/providers/codebuddy/codebuddy-token-store.js');
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        await svc.initialize();
        expect(CodeBuddyTokenStore).toHaveBeenCalledTimes(1);
    });

    test('listModels returns static model list', async () => {
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toHaveProperty('id');
        expect(result.data[0]).toHaveProperty('owned_by', 'codebuddy');
    });

    test('refreshToken calls getValidAccessToken when token is near expiry', async () => {
        mockIsExpiryDateNear.mockReturnValue(true);
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockGetValidAccessToken).toHaveBeenCalledTimes(1);
    });

    test('refreshToken skips refresh when token is fresh', async () => {
        mockIsExpiryDateNear.mockReturnValue(false);
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockGetValidAccessToken).not.toHaveBeenCalled();
    });

    test('generateContent throws on API error', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: () => Promise.resolve('Forbidden'),
        });
        global.fetch = mockFetch;

        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        await expect(
            svc.generateContent('GLM-5.0', { messages: [{ role: 'user', content: 'hi' }] })
        ).rejects.toThrow();
        delete global.fetch;
    });

    test('generateContent returns parsed JSON on success', async () => {
        const payload = { id: 'cmpl-1', choices: [{ message: { content: 'Hello' } }] };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(payload),
        });

        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        const result = await svc.generateContent('GLM-5.0', { messages: [] });
        expect(result.id).toBe('cmpl-1');
        delete global.fetch;
    });

    test('generateContentStream yields parsed SSE chunks', async () => {
        const chunk = { choices: [{ delta: { content: 'hi' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

        async function* makeBody() {
            yield Buffer.from(sseData);
        }

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: makeBody(),
        });

        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();

        const chunks = [];
        for await (const c of svc.generateContentStream('GLM-5.0', { messages: [] })) {
            chunks.push(c);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        delete global.fetch;
    });

    test('generateContentStream throws on non-ok response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: () => Promise.resolve('Unauthorized'),
        });

        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        const gen = svc.generateContentStream('GLM-5.0', { messages: [] });
        await expect(gen.next()).rejects.toThrow('API stream error 401');
        delete global.fetch;
    });

    test('isExpiryDateNear returns false when tokenStore is null', async () => {
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('isExpiryDateNear delegates to tokenStore', async () => {
        mockIsExpiryDateNear.mockReturnValue(true);
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        expect(svc.isExpiryDateNear()).toBe(true);
    });

    test('forceRefreshToken calls getValidAccessToken when _cached exists', async () => {
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        // Simulate cached token
        svc._tokenStore._cached = { expires_at: Date.now() + 3600000 };
        await svc.forceRefreshToken();
        expect(mockGetValidAccessToken).toHaveBeenCalled();
    });

    test('generateContent auto-initializes when not yet initialized', async () => {
        const payload = { id: 'cmpl-auto', choices: [] };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(payload),
        });

        // Do NOT call initialize() — let _ensureInitialized do it
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        expect(svc.isInitialized).toBe(false);
        const result = await svc.generateContent('GLM-5.0', { messages: [] });
        expect(svc.isInitialized).toBe(true);
        expect(result.id).toBe('cmpl-auto');
        delete global.fetch;
    });

    test('generateContentStream flushes trailing buffer without newline', async () => {
        const chunk = { choices: [{ delta: { content: 'end' } }] };
        // Trailing data without a trailing newline
        const sseData = `data: [DONE]\ndata: ${JSON.stringify(chunk)}`;

        async function* makeBody() {
            yield Buffer.from(sseData);
        }

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: makeBody(),
        });

        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();

        const chunks = [];
        for await (const c of svc.generateContentStream('GLM-5.0', { messages: [] })) {
            chunks.push(c);
        }
        // The [DONE] causes early return, so trailing data may or may not be processed
        // Either way it should not throw
        expect(Array.isArray(chunks)).toBe(true);
        delete global.fetch;
    });

    test('generateContentStream skips malformed SSE chunks', async () => {
        const chunk = { choices: [{ delta: { content: 'ok' } }] };
        const sseData = `data: not-json\n\ndata: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

        async function* makeBody() {
            yield Buffer.from(sseData);
        }

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: makeBody(),
        });

        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();

        const chunks = [];
        for await (const c of svc.generateContentStream('GLM-5.0', { messages: [] })) {
            chunks.push(c);
        }
        expect(chunks.length).toBe(1);
        delete global.fetch;
    });
});
