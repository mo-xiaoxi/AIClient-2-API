/**
 * Unit tests for src/providers/claude/claude-core.js
 *
 * Tests: ClaudeApiService construction, generateContent, generateContentStream,
 *        API call format, headers, error handling and retry logic.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequest = jest.fn();

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
    MODEL_PROVIDER: { CLAUDE_CUSTOM: 'claude-custom' },
    MODEL_PROTOCOL_PREFIX: { CLAUDE: 'claude' },
}));

await jest.unstable_mockModule('axios', () => ({
    default: {
        create: jest.fn(() => ({ request: mockRequest })),
    },
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

let ClaudeApiService;

beforeAll(async () => {
    const mod = await import('../../../src/providers/claude/claude-core.js');
    ClaudeApiService = mod.ClaudeApiService;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides = {}) {
    return new ClaudeApiService({
        CLAUDE_API_KEY: 'test-api-key',
        CLAUDE_BASE_URL: 'https://api.anthropic.com',
        REQUEST_MAX_RETRIES: 0,
        REQUEST_BASE_DELAY: 0,
        ...overrides,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeApiService — construction', () => {
    beforeEach(() => mockRequest.mockReset());

    test('throws when API key is missing', () => {
        expect(() => new ClaudeApiService({ CLAUDE_BASE_URL: 'https://api.anthropic.com' }))
            .toThrow('Claude API Key is required');
    });

    test('constructs successfully with required config', () => {
        const svc = makeService();
        expect(svc).toBeDefined();
        expect(svc.apiKey).toBe('test-api-key');
        expect(svc.baseUrl).toBe('https://api.anthropic.com');
    });

    test('useSystemProxy defaults to false', () => {
        const svc = makeService();
        expect(svc.useSystemProxy).toBe(false);
    });

    test('useSystemProxy can be set to true', () => {
        const svc = makeService({ USE_SYSTEM_PROXY_CLAUDE: true });
        expect(svc.useSystemProxy).toBe(true);
    });
});

describe('ClaudeApiService — generateContent (callApi)', () => {
    beforeEach(() => mockRequest.mockReset());

    test('calls /messages endpoint and returns response data', async () => {
        const responseBody = { id: 'msg-1', content: [{ text: 'Hello' }] };
        mockRequest.mockResolvedValueOnce({ data: responseBody });

        const svc = makeService();
        const result = await svc.generateContent('claude-3-5-sonnet-20241022', {
            messages: [{ role: 'user', content: 'Hi' }],
        });

        expect(result).toEqual(responseBody);
        expect(mockRequest).toHaveBeenCalledTimes(1);
        const [callArg] = mockRequest.mock.calls[0];
        expect(callArg.url).toBe('/messages');
        expect(callArg.method).toBe('post');
    });

    test('strips _monitorRequestId from request body before sending', async () => {
        mockRequest.mockResolvedValueOnce({ data: { ok: true } });
        const svc = makeService();
        const body = { messages: [], _monitorRequestId: 'req-123' };
        await svc.generateContent('claude-3-opus-20240229', body);

        const [callArg] = mockRequest.mock.calls[0];
        expect(callArg.data._monitorRequestId).toBeUndefined();
    });

    test('strips _requestBaseUrl from request body before sending', async () => {
        mockRequest.mockResolvedValueOnce({ data: {} });
        const svc = makeService();
        await svc.generateContent('m', { messages: [], _requestBaseUrl: 'http://x.com' });
        const [callArg] = mockRequest.mock.calls[0];
        expect(callArg.data._requestBaseUrl).toBeUndefined();
    });

    test('throws on 401 without retry', async () => {
        const err = { response: { status: 401 }, message: 'Unauthorized' };
        mockRequest.mockRejectedValueOnce(err);

        const svc = makeService();
        await expect(svc.generateContent('m', { messages: [] })).rejects.toMatchObject({ response: { status: 401 } });
        expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    test('throws on 403 without retry', async () => {
        const err = { response: { status: 403 }, message: 'Forbidden' };
        mockRequest.mockRejectedValueOnce(err);

        const svc = makeService();
        await expect(svc.generateContent('m', {})).rejects.toMatchObject({ response: { status: 403 } });
        expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    test('propagates non-retryable errors directly', async () => {
        const err = { response: { status: 400 }, message: 'Bad Request' };
        mockRequest.mockRejectedValueOnce(err);

        const svc = makeService({ REQUEST_MAX_RETRIES: 0 });
        await expect(svc.generateContent('m', {})).rejects.toMatchObject({ response: { status: 400 } });
    });
});

describe('ClaudeApiService — generateContentStream (streamApi)', () => {
    beforeEach(() => mockRequest.mockReset());

    test('yields parsed SSE chunks from stream', async () => {
        const chunk1 = { type: 'content_block_delta', delta: { text: 'Hello' } };
        const chunk2 = { type: 'message_stop' };

        const sseData = `event: content_block_delta\ndata: ${JSON.stringify(chunk1)}\n\nevent: message_stop\ndata: ${JSON.stringify(chunk2)}\n\n`;

        // Simulate a readable stream
        async function* makeStream() {
            yield Buffer.from(sseData);
        }

        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService();
        const chunks = [];
        for await (const c of svc.generateContentStream('m', { messages: [] })) {
            chunks.push(c);
        }

        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0]).toEqual(chunk1);
    });

    test('stream throws on 401', async () => {
        const err = { response: { status: 401 }, message: 'Unauthorized' };
        mockRequest.mockRejectedValueOnce(err);

        const svc = makeService();
        const gen = svc.generateContentStream('m', {});
        await expect(gen.next()).rejects.toMatchObject({ response: { status: 401 } });
    });

    test('stream throws on 403', async () => {
        const err = { response: { status: 403 }, message: 'Forbidden' };
        mockRequest.mockRejectedValueOnce(err);

        const svc = makeService();
        const gen = svc.generateContentStream('m', {});
        await expect(gen.next()).rejects.toMatchObject({ response: { status: 403 } });
    });

    test('stream stops at message_stop event', async () => {
        const stop = { type: 'message_stop' };
        const sseData = `data: ${JSON.stringify(stop)}\n\n`;

        async function* makeStream() {
            yield Buffer.from(sseData);
        }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService();
        const chunks = [];
        for await (const c of svc.generateContentStream('m', {})) {
            chunks.push(c);
        }
        // Should contain the stop event and then terminate
        expect(chunks.some(c => c.type === 'message_stop')).toBe(true);
    });
});

describe('ClaudeApiService — listModels', () => {
    test('returns a list of hardcoded models', async () => {
        const svc = makeService();
        const result = await svc.listModels();
        expect(result).toHaveProperty('models');
        expect(Array.isArray(result.models)).toBe(true);
        expect(result.models.length).toBeGreaterThan(0);
    });

    test('models have a name property', async () => {
        const svc = makeService();
        const result = await svc.listModels();
        for (const m of result.models) {
            expect(m).toHaveProperty('name');
        }
    });
});

// ---------------------------------------------------------------------------
// 补充测试：callApi 重试逻辑（429 / 5xx / 网络错误）
// ---------------------------------------------------------------------------

describe('ClaudeApiService — callApi retry logic', () => {
    beforeEach(() => mockRequest.mockReset());

    test('429 错误触发重试，重试成功后返回结果', async () => {
        // 设置 maxRetries=1，baseDelay=0 避免真实延时
        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        const successData = { id: 'msg-ok', content: [] };
        const err429 = { response: { status: 429 }, message: 'Too Many Requests' };

        // 第一次调用失败 429，第二次成功
        mockRequest
            .mockRejectedValueOnce(err429)
            .mockResolvedValueOnce({ data: successData });

        const result = await svc.generateContent('model', { messages: [] });
        expect(result).toEqual(successData);
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('429 重试耗尽后（maxRetries=1，连续失败）抛出错误', async () => {
        // REQUEST_MAX_RETRIES=1 配合 BASE_DELAY=1 避免等待太久
        // 两次都失败：retryCount=0 时可重试，retryCount=1 时 1<1=false 不再重试
        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 });
        const err429 = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
        mockRequest
            .mockRejectedValueOnce(err429)
            .mockRejectedValueOnce(err429); // 重试也失败

        await expect(svc.generateContent('m', { messages: [] }))
            .rejects.toMatchObject({ response: { status: 429 } });
        // 应调用两次：第一次 + 一次重试
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('5xx 错误触发重试，重试成功后返回结果', async () => {
        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        const successData = { id: 'msg-5xx', content: [] };
        const err500 = { response: { status: 500 }, message: 'Internal Server Error' };

        mockRequest
            .mockRejectedValueOnce(err500)
            .mockResolvedValueOnce({ data: successData });

        const result = await svc.generateContent('model', { messages: [] });
        expect(result).toEqual(successData);
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('503 错误（5xx 范围）触发重试', async () => {
        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        const successData = { id: 'msg-503' };
        const err503 = { response: { status: 503 }, message: 'Service Unavailable' };

        mockRequest
            .mockRejectedValueOnce(err503)
            .mockResolvedValueOnce({ data: successData });

        const result = await svc.generateContent('model', { messages: [] });
        expect(result).toEqual(successData);
    });

    test('网络错误（isRetryableNetworkError=true）触发重试', async () => {
        // 先让 isRetryableNetworkError 返回 true，再恢复
        const { isRetryableNetworkError } = await import('../../../src/utils/common.js');
        isRetryableNetworkError.mockReturnValueOnce(true);

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        const successData = { id: 'msg-net' };
        const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });

        mockRequest
            .mockRejectedValueOnce(netErr)
            .mockResolvedValueOnce({ data: successData });

        const result = await svc.generateContent('model', { messages: [] });
        expect(result).toEqual(successData);
    });

    test('网络错误重试耗尽（maxRetries=1，连续失败）后抛出', async () => {
        const { isRetryableNetworkError } = await import('../../../src/utils/common.js');
        isRetryableNetworkError.mockReturnValue(true);

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 });
        const netErr = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
        mockRequest
            .mockRejectedValueOnce(netErr)
            .mockRejectedValueOnce(netErr);

        await expect(svc.generateContent('m', {})).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        expect(mockRequest).toHaveBeenCalledTimes(2);

        isRetryableNetworkError.mockReturnValue(false);
    });
});

// ---------------------------------------------------------------------------
// 补充测试：streamApi 重试逻辑
// ---------------------------------------------------------------------------

describe('ClaudeApiService — streamApi retry logic', () => {
    beforeEach(() => mockRequest.mockReset());

    test('stream 429 错误触发重试并成功', async () => {
        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        const successChunk = { type: 'message_stop' };
        const sseData = `data: ${JSON.stringify(successChunk)}\n\n`;

        async function* makeStream() {
            yield Buffer.from(sseData);
        }

        const err429 = { response: { status: 429 }, message: 'Too Many Requests' };
        mockRequest
            .mockRejectedValueOnce(err429)
            .mockResolvedValueOnce({ data: makeStream() });

        const chunks = [];
        for await (const c of svc.generateContentStream('m', {})) {
            chunks.push(c);
        }
        expect(chunks.some(c => c.type === 'message_stop')).toBe(true);
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('stream 5xx 错误触发重试并成功', async () => {
        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        const successChunk = { type: 'message_stop' };
        const sseData = `data: ${JSON.stringify(successChunk)}\n\n`;

        async function* makeStream() {
            yield Buffer.from(sseData);
        }

        const err503 = { response: { status: 503 }, message: 'Service Unavailable' };
        mockRequest
            .mockRejectedValueOnce(err503)
            .mockResolvedValueOnce({ data: makeStream() });

        const chunks = [];
        for await (const c of svc.generateContentStream('m', {})) {
            chunks.push(c);
        }
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('stream 网络错误（isRetryableNetworkError=true）触发重试', async () => {
        const { isRetryableNetworkError } = await import('../../../src/utils/common.js');
        isRetryableNetworkError.mockReturnValueOnce(true);

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        const sseData = `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

        async function* makeStream() {
            yield Buffer.from(sseData);
        }

        const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        mockRequest
            .mockRejectedValueOnce(netErr)
            .mockResolvedValueOnce({ data: makeStream() });

        const chunks = [];
        for await (const c of svc.generateContentStream('m', {})) {
            chunks.push(c);
        }
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('stream 解析含 input_json_delta 类型的 chunk', async () => {
        const chunk = {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"key":' }
        };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

        async function* makeStream() {
            yield Buffer.from(sseData);
        }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService();
        const chunks = [];
        for await (const c of svc.generateContentStream('m', {})) {
            chunks.push(c);
        }
        expect(chunks[0]).toEqual(chunk);
    });

    test('stream 跳过无法解析的 JSON chunk（不抛异常）', async () => {
        // 混合有效和无效的 SSE 数据
        const validChunk = { type: 'message_stop' };
        const sseData = `data: not-valid-json\n\ndata: ${JSON.stringify(validChunk)}\n\n`;

        async function* makeStream() {
            yield Buffer.from(sseData);
        }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService();
        const chunks = [];
        // 应不抛异常
        for await (const c of svc.generateContentStream('m', {})) {
            chunks.push(c);
        }
        expect(chunks.some(c => c.type === 'message_stop')).toBe(true);
    });
});
