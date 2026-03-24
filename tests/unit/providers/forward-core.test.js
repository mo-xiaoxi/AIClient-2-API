import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

const requestMock = jest.fn();

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: (c) => c,
}));

await jest.unstable_mockModule('axios', () => ({
    default: {
        create: jest.fn(() => ({
            request: requestMock,
        })),
    },
}));

const { ForwardApiService } = await import('../../../src/providers/forward/forward-core.js');

describe('ForwardApiService', () => {
    beforeEach(() => {
        requestMock.mockReset();
    });

    test('constructor requires API key and base URL', () => {
        expect(
            () =>
                new ForwardApiService({
                    FORWARD_BASE_URL: 'http://127.0.0.1:1',
                })
        ).toThrow('API Key is required');
        expect(
            () =>
                new ForwardApiService({
                    FORWARD_API_KEY: 'k',
                })
        ).toThrow('Base URL is required');
    });

    test('callApi returns response data', async () => {
        requestMock.mockResolvedValueOnce({ data: { ok: true } });
        const svc = new ForwardApiService({
            FORWARD_API_KEY: 'sk',
            FORWARD_BASE_URL: 'http://127.0.0.1:9',
            REQUEST_MAX_RETRIES: 0,
        });
        const data = await svc.callApi('/v1/x', { a: 1 });
        expect(data).toEqual({ ok: true });
        expect(requestMock).toHaveBeenCalled();
    });

    test('callApi throws on 401 without retry', async () => {
        requestMock.mockRejectedValueOnce({
            response: { status: 401 },
            message: 'nope',
        });
        const svc = new ForwardApiService({
            FORWARD_API_KEY: 'sk',
            FORWARD_BASE_URL: 'http://127.0.0.1:9',
            REQUEST_MAX_RETRIES: 0,
        });
        await expect(svc.callApi('/p', {})).rejects.toMatchObject({ response: { status: 401 } });
    });

    test('callApi retries on 502 then succeeds', async () => {
        jest.useFakeTimers();
        requestMock
            .mockRejectedValueOnce({ response: { status: 502 }, message: 'bad' })
            .mockResolvedValueOnce({ data: { ok: true } });
        const svc = new ForwardApiService({
            FORWARD_API_KEY: 'sk',
            FORWARD_BASE_URL: 'http://127.0.0.1:9',
            REQUEST_MAX_RETRIES: 2,
            REQUEST_BASE_DELAY: 5,
        });
        const p = svc.callApi('/p', {});
        await jest.advanceTimersByTimeAsync(10);
        await expect(p).resolves.toEqual({ ok: true });
        expect(requestMock).toHaveBeenCalledTimes(2);
        jest.useRealTimers();
    });

    test('listModels returns data on success', async () => {
        requestMock.mockResolvedValueOnce({ data: { data: [{ id: 'm' }] } });
        const svc = new ForwardApiService({
            FORWARD_API_KEY: 'sk',
            FORWARD_BASE_URL: 'http://127.0.0.1:9',
            REQUEST_MAX_RETRIES: 0,
        });
        const out = await svc.listModels();
        expect(out).toEqual({ data: [{ id: 'm' }] });
    });

    test('listModels returns empty data on error', async () => {
        requestMock.mockRejectedValueOnce(new Error('network'));
        const svc = new ForwardApiService({
            FORWARD_API_KEY: 'sk',
            FORWARD_BASE_URL: 'http://127.0.0.1:9',
            REQUEST_MAX_RETRIES: 0,
        });
        const out = await svc.listModels();
        expect(out).toEqual({ data: [] });
    });

    test('generateContent strips monitor fields and calls endpoint', async () => {
        requestMock.mockResolvedValueOnce({ data: { x: 1 } });
        const svc = new ForwardApiService({
            FORWARD_API_KEY: 'sk',
            FORWARD_BASE_URL: 'http://127.0.0.1:9',
            REQUEST_MAX_RETRIES: 0,
        });
        const body = {
            endpoint: '/v1/chat/completions',
            _monitorRequestId: 'mid',
            _requestBaseUrl: 'http://x',
            foo: 1,
        };
        await svc.generateContent('m', body);
        expect(body._monitorRequestId).toBeUndefined();
        expect(requestMock).toHaveBeenCalled();
    });

    test('streamApi yields parsed SSE JSON chunks', async () => {
        const sse = 'data: {"id":1}\n\ndata: [DONE]\n\n';
        const stream = Readable.from([Buffer.from(sse)]);
        requestMock.mockResolvedValueOnce({ data: stream });
        const svc = new ForwardApiService({
            FORWARD_API_KEY: 'sk',
            FORWARD_BASE_URL: 'http://127.0.0.1:9',
            REQUEST_MAX_RETRIES: 0,
        });
        const out = [];
        for await (const chunk of svc.streamApi('/s', { stream: true })) {
            out.push(chunk);
        }
        expect(out).toEqual([{ id: 1 }]);
    });
});
