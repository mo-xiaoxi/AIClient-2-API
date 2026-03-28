/**
 * OpenAIResponsesApiService — 构造函数与错误分支（axios 全 mock）
 */
import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const mockRequest = jest.fn();

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        configureAxiosProxy: jest.fn(),
        configureTLSSidecar: jest.fn((cfg) => cfg),
    }));

    await jest.unstable_mockModule('axios', () => ({
        __esModule: true,
        default: {
            create: jest.fn(() => ({ request: mockRequest })),
        },
    }));

    await jest.unstable_mockModule('http', () => ({
        __esModule: true,
        Agent: jest.fn(function Agent() {
            return {};
        }),
    }));

    await jest.unstable_mockModule('https', () => ({
        __esModule: true,
        Agent: jest.fn(function Agent() {
            return {};
        }),
    }));
});

describe('OpenAIResponsesApiService', () => {
    beforeEach(() => {
        mockRequest.mockReset();
    });

    test('constructor throws without API key', async () => {
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        expect(() => new OpenAIResponsesApiService({})).toThrow(/API Key is required/);
    });

    test('constructor sets baseUrl and creates axios instance', async () => {
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const axios = (await import('axios')).default;
        const svc = new OpenAIResponsesApiService({
            OPENAI_API_KEY: 'sk-test',
            OPENAI_BASE_URL: 'https://example.com/v1',
        });
        expect(svc.baseUrl).toBe('https://example.com/v1');
        expect(axios.create).toHaveBeenCalled();
    });

    test('callApi returns data on success', async () => {
        mockRequest.mockResolvedValueOnce({ data: { ok: true } });
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test', REQUEST_MAX_RETRIES: 0 });
        const out = await svc.callApi('/responses', { foo: 1 });
        expect(out).toEqual({ ok: true });
    });

    test('callApi propagates 401', async () => {
        const err = new Error('unauth');
        err.response = { status: 401, data: {} };
        mockRequest.mockRejectedValueOnce(err);
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test', REQUEST_MAX_RETRIES: 0 });
        await expect(svc.callApi('/x', {})).rejects.toBe(err);
    });

    test('callApi retries on 429 and succeeds', async () => {
        const err429 = Object.assign(new Error('rate limit'), { response: { status: 429, data: {} } });
        mockRequest
            .mockRejectedValueOnce(err429)
            .mockResolvedValueOnce({ data: { retried: true } });
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({
            OPENAI_API_KEY: 'sk-test',
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 0,
        });
        const out = await svc.callApi('/responses', {});
        expect(out).toEqual({ retried: true });
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('callApi retries on 500 and succeeds', async () => {
        const err500 = Object.assign(new Error('server error'), { response: { status: 500, data: {} } });
        mockRequest
            .mockRejectedValueOnce(err500)
            .mockResolvedValueOnce({ data: { ok: true } });
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({
            OPENAI_API_KEY: 'sk-test',
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 0,
        });
        const out = await svc.callApi('/responses', {});
        expect(out).toEqual({ ok: true });
    });

    test('callApi exhausts retries and throws on 429', async () => {
        const err429 = Object.assign(new Error('rate limit'), { response: { status: 429, data: {} } });
        mockRequest.mockRejectedValue(err429);
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({
            OPENAI_API_KEY: 'sk-test',
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 0,
        });
        await expect(svc.callApi('/responses', {})).rejects.toBe(err429);
        // 1 initial + 1 retry = 2 calls
        expect(mockRequest).toHaveBeenCalledTimes(2);
        mockRequest.mockReset();
    });

    test('callApi throws non-retryable error directly', async () => {
        const err404 = Object.assign(new Error('not found'), { response: { status: 404, data: {} } });
        mockRequest.mockRejectedValueOnce(err404);
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test', REQUEST_MAX_RETRIES: 3 });
        await expect(svc.callApi('/responses', {})).rejects.toBe(err404);
        expect(mockRequest).toHaveBeenCalledTimes(1);
    });
});

describe('OpenAIResponsesApiService — streamApi', () => {
    beforeEach(() => {
        mockRequest.mockReset();
    });

    test('yields parsed SSE chunks and stops at [DONE]', async () => {
        const chunk = { type: 'response.output_text.delta', delta: 'hello' };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

        async function* makeStream() {
            yield Buffer.from(sseData);
        }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        const results = [];
        for await (const c of svc.streamApi('/responses', {})) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(chunk);
    });

    test('yields multiple chunks across buffer boundaries', async () => {
        const chunk1 = { id: '1', delta: 'foo' };
        const chunk2 = { id: '2', delta: 'bar' };
        const sseData = `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`;

        async function* makeStream() {
            // Split into two yields to test buffering
            const bytes = Buffer.from(sseData);
            yield bytes.slice(0, Math.floor(bytes.length / 2));
            yield bytes.slice(Math.floor(bytes.length / 2));
        }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        const results = [];
        for await (const c of svc.streamApi('/responses', {})) {
            results.push(c);
        }
        expect(results).toHaveLength(2);
    });

    test('propagates 401 during stream', async () => {
        const err = Object.assign(new Error('unauth'), { response: { status: 401, data: {} } });
        mockRequest.mockRejectedValueOnce(err);

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test', REQUEST_MAX_RETRIES: 0 });
        await expect(async () => {
            for await (const _ of svc.streamApi('/responses', {})) { /* drain */ }
        }).rejects.toBe(err);
    });

    test('retries on 429 during stream and yields chunks', async () => {
        const err429 = Object.assign(new Error('rate limit'), { response: { status: 429, data: {} } });
        const chunk = { delta: 'ok' };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

        async function* makeStream() { yield Buffer.from(sseData); }

        mockRequest
            .mockRejectedValueOnce(err429)
            .mockResolvedValueOnce({ data: makeStream() });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({
            OPENAI_API_KEY: 'sk-test',
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 0,
        });
        const results = [];
        for await (const c of svc.streamApi('/responses', {})) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
        expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    test('retries on 500 during stream and yields chunks', async () => {
        const err500 = Object.assign(new Error('server err'), { response: { status: 500, data: {} } });
        const chunk = { delta: 'recovered' };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

        async function* makeStream() { yield Buffer.from(sseData); }

        mockRequest
            .mockRejectedValueOnce(err500)
            .mockResolvedValueOnce({ data: makeStream() });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({
            OPENAI_API_KEY: 'sk-test',
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 0,
        });
        const results = [];
        for await (const c of svc.streamApi('/responses', {})) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
    });

    test('throws non-retryable stream error directly', async () => {
        const err403 = Object.assign(new Error('forbidden'), { response: { status: 403, data: {} } });
        mockRequest.mockRejectedValueOnce(err403);

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test', REQUEST_MAX_RETRIES: 3 });
        await expect(async () => {
            for await (const _ of svc.streamApi('/responses', {})) { /* drain */ }
        }).rejects.toBe(err403);
    });
});

describe('OpenAIResponsesApiService — generateContent', () => {
    beforeEach(() => {
        mockRequest.mockReset();
    });

    test('returns parsed response body', async () => {
        const payload = { output: [{ type: 'message', content: [{ text: 'Hello' }] }] };
        mockRequest.mockResolvedValueOnce({ data: payload });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        const result = await svc.generateContent('gpt-4o', { input: 'hi' });
        expect(result).toEqual(payload);
    });

    test('removes _monitorRequestId from requestBody', async () => {
        mockRequest.mockResolvedValueOnce({ data: {} });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        const body = { input: 'test', _monitorRequestId: 'req-999' };
        await svc.generateContent('gpt-4o', body);
        expect(body._monitorRequestId).toBeUndefined();
        expect(svc.config._monitorRequestId).toBe('req-999');
    });

    test('removes _requestBaseUrl from requestBody', async () => {
        mockRequest.mockResolvedValueOnce({ data: {} });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        const body = { input: 'test', _requestBaseUrl: 'http://custom.example.com' };
        await svc.generateContent('gpt-4o', body);
        expect(body._requestBaseUrl).toBeUndefined();
    });
});

describe('OpenAIResponsesApiService — generateContentStream', () => {
    beforeEach(() => {
        mockRequest.mockReset();
    });

    test('yields chunks from streamApi', async () => {
        const chunk = { type: 'response.output_text.delta', delta: 'hi' };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

        async function* makeStream() { yield Buffer.from(sseData); }
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        const results = [];
        for await (const c of svc.generateContentStream('gpt-4o', { input: 'hello' })) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(chunk);
    });

    test('removes _monitorRequestId before streaming', async () => {
        async function* makeStream() {}
        mockRequest.mockResolvedValueOnce({ data: makeStream() });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        const body = { input: 'test', _monitorRequestId: 'stream-req-1', _requestBaseUrl: 'http://x.com' };
        for await (const _ of svc.generateContentStream('gpt-4o', body)) { /* drain */ }
        expect(body._monitorRequestId).toBeUndefined();
        expect(body._requestBaseUrl).toBeUndefined();
        expect(svc.config._monitorRequestId).toBe('stream-req-1');
    });
});

describe('OpenAIResponsesApiService — listModels', () => {
    beforeEach(() => {
        mockRequest.mockReset();
    });

    test('returns model list on success', async () => {
        const modelData = { object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] };
        mockRequest.mockResolvedValueOnce({ data: modelData });

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        expect(result.data).toHaveLength(2);
    });

    test('throws on API error', async () => {
        const err = Object.assign(new Error('forbidden'), { response: { status: 403, data: 'Forbidden' } });
        mockRequest.mockRejectedValueOnce(err);

        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test' });
        await expect(svc.listModels()).rejects.toBe(err);
    });
});
