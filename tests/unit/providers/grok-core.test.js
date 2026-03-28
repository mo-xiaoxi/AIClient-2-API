/**
 * Unit tests for src/providers/grok/grok-core.js
 *
 * Tests: GrokApiService construction, initialize, buildHeaders,
 *        generateContent, generateContentStream, isExpiryDateNear.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { Readable } from 'node:stream';

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

    test('marks retryable network errors with skipErrorCount', async () => {
        const { isRetryableNetworkError } = await import('../../../src/utils/common.js');
        isRetryableNetworkError.mockReturnValueOnce(true);
        const svc = makeService();
        const err = { message: 'econnreset', code: 'ECONNRESET' };
        svc.classifyApiError(err);
        expect(err.shouldSwitchCredential).toBe(true);
        expect(err.skipErrorCount).toBe(true);
    });
});

describe('GrokApiService — genStatsigId', () => {
    test('returns base64 payload containing TypeError text', () => {
        const svc = makeService();
        const id = svc.genStatsigId();
        expect(typeof id).toBe('string');
        const decoded = Buffer.from(id, 'base64').toString('utf8');
        expect(decoded).toContain('TypeError');
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

describe('GrokApiService — _extractPostId', () => {
    test('extracts id from /post/<id> URL', () => {
        const svc = makeService();
        const id = 'abcdef1234567890abcdef1234567890';
        expect(svc._extractPostId(`https://grok.com/imagine/post/${id}`)).toBe(id);
    });

    test('extracts id from /generated/<id>/ URL', () => {
        const svc = makeService();
        const id = 'abcdef1234567890abcdef1234567890';
        expect(svc._extractPostId(`https://assets.grok.com/generated/${id}/video.mp4`)).toBe(id);
    });

    test('returns null for non-matching text', () => {
        const svc = makeService();
        expect(svc._extractPostId('https://grok.com/chat')).toBeNull();
    });

    test('returns null for null input', () => {
        const svc = makeService();
        expect(svc._extractPostId(null)).toBeNull();
    });
});

describe('GrokApiService — buildPayload', () => {
    test('returns payload with expected fields', () => {
        const svc = makeService();
        const body = { messages: [{ role: 'user', content: 'Hello' }] };
        const payload = svc.buildPayload('grok-3', body);
        expect(payload).toHaveProperty('message');
        expect(payload).toHaveProperty('modelName');
        expect(payload).toHaveProperty('modelMode');
    });

    test('uses grok-3 as fallback for unknown model', () => {
        const svc = makeService();
        const body = { messages: [{ role: 'user', content: 'Hi' }] };
        const payload = svc.buildPayload('unknown-model', body);
        expect(payload.modelName).toBe('grok-3');
    });

    test('sets disableNsfwFilter when nsfw=true', () => {
        const svc = makeService();
        const body = { messages: [{ role: 'user', content: 'Hi' }], nsfw: true };
        const payload = svc.buildPayload('grok-3', body);
        expect(payload.disableNsfwFilter).toBe(true);
    });

    test('handles grok-3-mini model mapping', () => {
        const svc = makeService();
        const body = { messages: [{ role: 'user', content: 'Hi' }] };
        const payload = svc.buildPayload('grok-3-mini', body);
        expect(payload.modelMode).toBe('MODEL_MODE_GROK_3_MINI_THINKING');
    });

    test('combines multi-turn messages into single message string', () => {
        const svc = makeService();
        const body = {
            messages: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
                { role: 'user', content: 'Follow up' },
            ]
        };
        const payload = svc.buildPayload('grok-3', body);
        expect(payload.message).toContain('Follow up');
        expect(payload.message).toContain('Hi there');
    });

    test('handles array content in messages', () => {
        const svc = makeService();
        const body = {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Image desc' }, { type: 'image_url', image_url: { url: 'http://img.example.com/a.jpg' } }] }]
        };
        const payload = svc.buildPayload('grok-3', body);
        expect(payload.message).toContain('Image desc');
    });
});

describe('GrokApiService — setupNsfw', () => {
    beforeEach(() => mockAxios.mockReset());

    test('calls acceptTos, setBirthDate, enableNsfwAccount', async () => {
        const svc = makeService();
        svc.nsfwSetupDone = false;
        // Mock all axios calls to succeed
        mockAxios.mockResolvedValue({ data: {} });

        await svc.setupNsfw();
        expect(svc.nsfwSetupDone).toBe(true);
        expect(mockAxios).toHaveBeenCalledTimes(3);
    });

    test('is idempotent (does not call again when nsfwSetupDone=true)', async () => {
        const svc = makeService();
        svc.nsfwSetupDone = true;
        await svc.setupNsfw();
        expect(mockAxios).not.toHaveBeenCalled();
    });

    test('does not throw when enableNsfwAccount throws', async () => {
        const svc = makeService();
        svc.nsfwSetupDone = false;
        // First two calls succeed (acceptTos, setBirthDate), third throws
        mockAxios.mockResolvedValueOnce({ data: {} });
        mockAxios.mockResolvedValueOnce({ data: {} });
        mockAxios.mockRejectedValueOnce(new Error('grpc error'));

        await expect(svc.setupNsfw()).resolves.not.toThrow();
        expect(svc.nsfwSetupDone).toBe(false);
    });
});

describe('GrokApiService — refreshToken', () => {
    test('calls poolManager.resetProviderRefreshStatus when poolManager exists', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        const mockPool = { resetProviderRefreshStatus: jest.fn() };
        getProviderPoolManager.mockReturnValueOnce(mockPool);

        const svc = makeService({ uuid: 'test-uuid' });
        await svc.refreshToken();
        expect(mockPool.resetProviderRefreshStatus).toHaveBeenCalled();
    });

    test('does not throw when poolManager is null', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        getProviderPoolManager.mockReturnValueOnce(null);

        const svc = makeService();
        await expect(svc.refreshToken()).resolves.not.toThrow();
    });
});

describe('GrokApiService — getUsageLimits', () => {
    beforeEach(() => mockAxios.mockReset());

    test('returns usage data on success', async () => {
        const svc = makeService();
        mockAxios.mockResolvedValueOnce({
            data: { remainingQueries: 80, totalQueries: 100 }
        });
        const result = await svc.getUsageLimits();
        expect(result).toHaveProperty('remaining');
        expect(svc.lastSyncAt).toBeDefined();
    });

    test('uses token-based fields when totalQueries=0', async () => {
        const svc = makeService();
        mockAxios.mockResolvedValueOnce({
            data: { remainingTokens: 5000, totalTokens: 10000, totalQueries: 0 }
        });
        const result = await svc.getUsageLimits();
        expect(result.unit).toBe('tokens');
    });

    test('throws on axios failure', async () => {
        const svc = makeService();
        mockAxios.mockRejectedValueOnce(new Error('Network timeout'));
        await expect(svc.getUsageLimits()).rejects.toThrow('Network timeout');
    });
});

describe('GrokApiService — generateContentStream (basic)', () => {

    beforeEach(() => mockAxios.mockReset());

    test('yields parsed JSON chunks from SSE stream', async () => {
        const svc = makeService();
        svc.isInitialized = true;

        const chunk = { result: { response: { token: 'Hello', responseId: 'r1' } } };
        const sseData = `data: ${JSON.stringify(chunk)}\n\n`;
        const readable = Readable.from([Buffer.from(sseData)]);
        mockAxios.mockResolvedValueOnce({ data: readable });

        const chunks = [];
        for await (const c of svc.generateContentStream('grok-3', { messages: [{ role: 'user', content: 'Hi' }] })) {
            chunks.push(c);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        const hasToken = chunks.some(c => c.result?.response?.token === 'Hello');
        expect(hasToken).toBe(true);
    });

    test('throws on HTTP error (non-retryable)', async () => {
        const svc = makeService({ REQUEST_MAX_RETRIES: 0 });
        svc.isInitialized = true;

        const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
        mockAxios.mockRejectedValueOnce(err);

        const gen = svc.generateContentStream('grok-3', { messages: [{ role: 'user', content: 'Hi' }] });
        await expect(gen.next()).rejects.toThrow();
    });
});

describe('GrokApiService — listModels', () => {
    test('returns data with model list', async () => {
        const svc = makeService();
        const result = await svc.listModels();
        expect(result).toHaveProperty('data');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toHaveProperty('id');
        expect(result.data[0]).toHaveProperty('object', 'model');
    });
});

describe('GrokApiService — createPost', () => {
    beforeEach(() => mockAxios.mockReset());

    test('returns postId on success', async () => {
        const svc = makeService();
        mockAxios.mockResolvedValueOnce({ data: { post: { id: 'post-123' } } });
        const postId = await svc.createPost('VIDEO', 'http://example.com/video.mp4', 'test prompt');
        expect(postId).toBe('post-123');
    });

    test('returns undefined when response has no postId', async () => {
        const svc = makeService();
        mockAxios.mockResolvedValueOnce({ data: {} });
        const postId = await svc.createPost('IMAGE', null, null);
        expect(postId).toBeUndefined();
    });

    test('returns null on axios failure', async () => {
        const svc = makeService();
        mockAxios.mockRejectedValueOnce(new Error('Network error'));
        const postId = await svc.createPost('IMAGE', null, 'prompt');
        expect(postId).toBeNull();
    });

    test('includes prompt in payload when provided', async () => {
        const svc = makeService();
        let capturedData;
        mockAxios.mockImplementationOnce((cfg) => {
            capturedData = cfg.data;
            return Promise.resolve({ data: { post: { id: 'p1' } } });
        });
        await svc.createPost('TEXT', null, 'my prompt');
        expect(capturedData.prompt).toBe('my prompt');
    });
});

describe('GrokApiService — upscaleVideo', () => {
    beforeEach(() => mockAxios.mockReset());

    test('returns input URL unchanged when null', async () => {
        const svc = makeService();
        const result = await svc.upscaleVideo(null);
        expect(result).toBeNull();
    });

    test('returns original URL when no video ID can be extracted', async () => {
        const svc = makeService();
        const url = 'https://example.com/no-id-here';
        const result = await svc.upscaleVideo(url);
        expect(result).toBe(url);
    });

    test('returns hdMediaUrl on success', async () => {
        const svc = makeService();
        const videoId = 'abcdef1234567890abcdef1234567890';
        const url = `https://grok.com/generated/${videoId}/video.mp4`;
        mockAxios.mockResolvedValueOnce({ data: { hdMediaUrl: 'https://hd.example.com/video.mp4' } });
        const result = await svc.upscaleVideo(url);
        expect(result).toBe('https://hd.example.com/video.mp4');
    });

    test('returns original URL when axios fails', async () => {
        const svc = makeService();
        const videoId = 'abcdef1234567890abcdef1234567890';
        const url = `https://grok.com/generated/${videoId}/video.mp4`;
        mockAxios.mockRejectedValueOnce(new Error('error'));
        const result = await svc.upscaleVideo(url);
        expect(result).toBe(url);
    });
});

describe('GrokApiService — createVideoShareLink', () => {
    beforeEach(() => mockAxios.mockReset());

    test('returns null when postId is null', async () => {
        const svc = makeService();
        const result = await svc.createVideoShareLink(null);
        expect(result).toBeNull();
    });

    test('returns public resourceUrl on success', async () => {
        const svc = makeService();
        const postId = 'abcdef1234567890abcdef12345678ab';
        mockAxios.mockResolvedValueOnce({
            data: { shareLink: `https://x.ai/imagine/post/${postId}` },
        });
        const result = await svc.createVideoShareLink(postId);
        expect(result).toContain('imagine-public');
        expect(result).toContain('.mp4');
    });

    test('returns null when shareLink is missing from response', async () => {
        const svc = makeService();
        mockAxios.mockResolvedValueOnce({ data: {} });
        const result = await svc.createVideoShareLink('post-id');
        expect(result).toBeNull();
    });

    test('returns null on axios failure', async () => {
        const svc = makeService();
        mockAxios.mockRejectedValueOnce(Object.assign(new Error('error'), { response: { data: 'err' } }));
        const result = await svc.createVideoShareLink('post-id');
        expect(result).toBeNull();
    });
});

describe('GrokApiService — generateContent', () => {
    beforeEach(() => mockAxios.mockReset());

    test('collects token from stream and returns collected result', async () => {
        const svc = makeService();
        svc.isInitialized = true;

        const chunk = { result: { response: { token: 'Hello', responseId: 'r1' } } };
        const sseData = `data: ${JSON.stringify(chunk)}\n\n`;
        const readable = Readable.from([Buffer.from(sseData)]);
        mockAxios.mockResolvedValueOnce({ data: readable });

        const result = await svc.generateContent('grok-3', { messages: [{ role: 'user', content: 'Hi' }] });
        expect(result.message).toBe('Hello');
        expect(result.responseId).toBe('r1');
    });
});

describe('GrokApiService — uploadFile', () => {
    beforeEach(() => mockAxios.mockReset());

    test('returns null when b64 is empty (non-data-url)', async () => {
        const svc = makeService();
        const result = await svc.uploadFile('https://example.com/file.png');
        expect(result).toBeNull();
    });

    test('returns upload response data when given a data URL', async () => {
        const svc = makeService();
        const fakeData = 'some-base64-content';
        const dataUrl = `data:image/png;base64,${fakeData}`;
        mockAxios.mockResolvedValueOnce({ data: { fileId: 'file-123' } });
        const result = await svc.uploadFile(dataUrl);
        expect(result).toEqual({ fileId: 'file-123' });
    });

    test('returns null on upload failure', async () => {
        const svc = makeService();
        const dataUrl = 'data:image/png;base64,abc123';
        mockAxios.mockRejectedValueOnce(new Error('upload error'));
        const result = await svc.uploadFile(dataUrl);
        expect(result).toBeNull();
    });
});
