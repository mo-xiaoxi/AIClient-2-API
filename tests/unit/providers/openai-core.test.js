/**
 * Unit tests for src/providers/openai/openai-core.js
 *
 * Tests: OpenAIApiService construction, generateContent, generateContentStream,
 *        listModels, custom base URL / headers, error handling.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequest = jest.fn();
const mockGet = jest.fn();

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn((cfg) => cfg),
    getProxyConfigForProvider: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    isRetryableNetworkError: jest.fn(() => false),
    MODEL_PROVIDER: { OPENAI_CUSTOM: 'openai-custom' },
    MODEL_PROTOCOL_PREFIX: { OPENAI: 'openai' },
}));

const mockAxiosInstance = { request: mockRequest, get: mockGet };

await jest.unstable_mockModule('axios', () => ({
    default: {
        create: jest.fn(() => mockAxiosInstance),
    },
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

let OpenAIApiService;

beforeAll(async () => {
    const mod = await import('../../../src/providers/openai/openai-core.js');
    OpenAIApiService = mod.OpenAIApiService;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides = {}) {
    return new OpenAIApiService({
        OPENAI_API_KEY: 'sk-test',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        REQUEST_MAX_RETRIES: 0,
        REQUEST_BASE_DELAY: 0,
        ...overrides,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIApiService — construction', () => {
    beforeEach(() => { mockRequest.mockReset(); mockGet.mockReset(); });

    test('throws when API key is missing', () => {
        expect(() => new OpenAIApiService({ OPENAI_BASE_URL: 'https://api.openai.com/v1' }))
            .toThrow('OpenAI API Key is required');
    });

    test('constructs successfully with required config', () => {
        const svc = makeService();
        expect(svc).toBeDefined();
        expect(svc.apiKey).toBe('sk-test');
        expect(svc.baseUrl).toBe('https://api.openai.com/v1');
    });

    test('useSystemProxy defaults to false', () => {
        const svc = makeService();
        expect(svc.useSystemProxy).toBe(false);
    });

    test('useSystemProxy can be set to true', () => {
        const svc = makeService({ USE_SYSTEM_PROXY_OPENAI: true });
        expect(svc.useSystemProxy).toBe(true);
    });
});

describe('OpenAIApiService — generateContent', () => {
    beforeEach(() => { mockRequest.mockReset(); mockGet.mockReset(); });

    test('calls /chat/completions endpoint and returns data', async () => {
        const responseData = { id: 'chatcmpl-1', choices: [] };
        mockRequest.mockResolvedValueOnce({ data: responseData });

        const svc = makeService();
        const result = await svc.generateContent('gpt-4', { messages: [] });

        expect(result).toEqual(responseData);
        const [callArg] = mockRequest.mock.calls[0];
        expect(callArg.url).toBe('/chat/completions');
        expect(callArg.method).toBe('post');
    });

    test('strips _monitorRequestId from body', async () => {
        mockRequest.mockResolvedValueOnce({ data: {} });
        const svc = makeService();
        await svc.generateContent('m', { messages: [], _monitorRequestId: 'x' });
        expect(mockRequest.mock.calls[0][0].data._monitorRequestId).toBeUndefined();
    });

    test('strips _requestBaseUrl from body', async () => {
        mockRequest.mockResolvedValueOnce({ data: {} });
        const svc = makeService();
        await svc.generateContent('m', { messages: [], _requestBaseUrl: 'http://other.com' });
        expect(mockRequest.mock.calls[0][0].data._requestBaseUrl).toBeUndefined();
    });

    test('throws on 401 without retry', async () => {
        mockRequest.mockRejectedValueOnce({ response: { status: 401 }, message: 'Unauthorized' });
        const svc = makeService();
        await expect(svc.generateContent('m', {})).rejects.toMatchObject({ response: { status: 401 } });
        expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    test('throws on 403 without retry', async () => {
        mockRequest.mockRejectedValueOnce({ response: { status: 403 }, message: 'Forbidden' });
        const svc = makeService();
        await expect(svc.generateContent('m', {})).rejects.toMatchObject({ response: { status: 403 } });
    });

    test('propagates 400 without retry', async () => {
        mockRequest.mockRejectedValueOnce({ response: { status: 400 }, message: 'Bad Request' });
        const svc = makeService({ REQUEST_MAX_RETRIES: 0 });
        await expect(svc.generateContent('m', {})).rejects.toMatchObject({ response: { status: 400 } });
        expect(mockRequest).toHaveBeenCalledTimes(1);
    });
});

describe('OpenAIApiService — generateContentStream', () => {
    beforeEach(() => { mockRequest.mockReset(); mockGet.mockReset(); });

    test('yields parsed SSE chunks', async () => {
        const chunk = { id: 'c1', choices: [{ delta: { content: 'hi' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\ndata: [DONE]\n`;

        async function* makeStream() {
            yield Buffer.from(sseData);
        }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService();
        const chunks = [];
        for await (const c of svc.generateContentStream('m', { messages: [] })) {
            chunks.push(c);
        }
        expect(chunks).toEqual([chunk]);
    });

    test('stream stops at [DONE]', async () => {
        const sseData = 'data: [DONE]\n';
        async function* makeStream() {
            yield Buffer.from(sseData);
        }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService();
        const chunks = [];
        for await (const c of svc.generateContentStream('m', {})) {
            chunks.push(c);
        }
        expect(chunks).toHaveLength(0);
    });

    test('stream sets stream: true in request body', async () => {
        async function* makeStream() { /* empty */ }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService();
        const gen = svc.generateContentStream('m', { messages: [] });
        await gen.next(); // consume to trigger the request

        const callArg = mockRequest.mock.calls[0][0];
        expect(callArg.data.stream).toBe(true);
    });

    test('throws on 401 in stream', async () => {
        mockRequest.mockRejectedValueOnce({ response: { status: 401 }, message: 'Unauthorized' });
        const svc = makeService();
        const gen = svc.generateContentStream('m', {});
        await expect(gen.next()).rejects.toMatchObject({ response: { status: 401 } });
    });
});

describe('OpenAIApiService — listModels', () => {
    beforeEach(() => { mockRequest.mockReset(); mockGet.mockReset(); });

    test('calls GET /models and returns data', async () => {
        const modelList = { data: [{ id: 'gpt-4' }] };
        mockGet.mockResolvedValueOnce({ data: modelList });

        const svc = makeService();
        const result = await svc.listModels();
        expect(result).toEqual(modelList);
    });

    test('throws on listModels error', async () => {
        mockGet.mockRejectedValueOnce({ response: { status: 500 }, message: 'Server Error' });
        const svc = makeService();
        await expect(svc.listModels()).rejects.toMatchObject({ response: { status: 500 } });
    });
});

describe('OpenAIApiService — callApi retry logic', () => {
    beforeEach(() => { mockRequest.mockReset(); mockGet.mockReset(); });

    test('retries on 429 and succeeds', async () => {
        const err429 = { response: { status: 429 }, message: 'Rate limited' };
        mockRequest
            .mockRejectedValueOnce(err429)
            .mockResolvedValueOnce({ data: { ok: true } });

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 });
        const result = await svc.callApi('/chat/completions', {});
        expect(result).toEqual({ ok: true });
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('retries on 500 and succeeds', async () => {
        const err500 = { response: { status: 500 }, message: 'Server error' };
        mockRequest
            .mockRejectedValueOnce(err500)
            .mockResolvedValueOnce({ data: { ok: true } });

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 });
        const result = await svc.callApi('/chat/completions', {});
        expect(result).toEqual({ ok: true });
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('retries on network error and succeeds', async () => {
        const { isRetryableNetworkError } = await import('../../../src/utils/common.js');
        isRetryableNetworkError.mockReturnValueOnce(true);

        const netErr = { code: 'ECONNRESET', message: 'connection reset' };
        mockRequest
            .mockRejectedValueOnce(netErr)
            .mockResolvedValueOnce({ data: { ok: true } });

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 });
        const result = await svc.callApi('/chat/completions', {});
        expect(result).toEqual({ ok: true });
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });
});

describe('OpenAIApiService — streamApi retry logic', () => {
    beforeEach(() => { mockRequest.mockReset(); mockGet.mockReset(); });

    test('retries stream on 429 and yields chunks', async () => {
        const err429 = { response: { status: 429 }, message: 'Rate limited' };
        const chunk = { choices: [{ delta: { content: 'retried' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\ndata: [DONE]\n`;

        async function* makeStream() { yield Buffer.from(sseData); }
        mockRequest
            .mockRejectedValueOnce(err429)
            .mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 });
        const chunks = [];
        for await (const c of svc.streamApi('/chat/completions', {})) {
            chunks.push(c);
        }
        expect(chunks).toHaveLength(1);
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('retries stream on 500 and yields chunks', async () => {
        const err500 = { response: { status: 500 }, message: 'Server error' };
        const chunk = { choices: [{ delta: { content: 'ok' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\ndata: [DONE]\n`;

        async function* makeStream() { yield Buffer.from(sseData); }
        mockRequest
            .mockRejectedValueOnce(err500)
            .mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 });
        const chunks = [];
        for await (const c of svc.streamApi('/chat/completions', {})) {
            chunks.push(c);
        }
        expect(chunks).toHaveLength(1);
    });

    test('retries stream on network error and yields chunks', async () => {
        const { isRetryableNetworkError } = await import('../../../src/utils/common.js');
        isRetryableNetworkError.mockReturnValueOnce(true);

        const netErr = { code: 'ECONNRESET', message: 'connection reset' };
        const chunk = { choices: [{ delta: { content: 'ok' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\ndata: [DONE]\n`;

        async function* makeStream() { yield Buffer.from(sseData); }
        mockRequest
            .mockRejectedValueOnce(netErr)
            .mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 });
        const chunks = [];
        for await (const c of svc.streamApi('/chat/completions', {})) {
            chunks.push(c);
        }
        expect(chunks).toHaveLength(1);
    });

    test('stream skips malformed JSON chunks', async () => {
        const chunk = { choices: [{ delta: { content: 'ok' } }] };
        const sseData = `data: not-json\ndata: ${JSON.stringify(chunk)}\ndata: [DONE]\n`;

        async function* makeStream() { yield Buffer.from(sseData); }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const svc = makeService();
        const chunks = [];
        for await (const c of svc.streamApi('/chat/completions', {})) {
            chunks.push(c);
        }
        // Only valid JSON chunk should be yielded
        expect(chunks).toHaveLength(1);
    });
});

describe('OpenAIApiService — generateContentStream internal fields', () => {
    beforeEach(() => { mockRequest.mockReset(); mockGet.mockReset(); });

    test('strips _monitorRequestId from body', async () => {
        async function* emptyStream() {}
        mockRequest.mockResolvedValueOnce({ data: emptyStream() });

        const svc = makeService();
        const body = { messages: [], _monitorRequestId: 'req-123', _requestBaseUrl: 'http://x.com' };
        for await (const _ of svc.generateContentStream('m', body)) {}
        // Fields should be stripped from body
        expect(body._monitorRequestId).toBeUndefined();
        expect(body._requestBaseUrl).toBeUndefined();
    });
});
