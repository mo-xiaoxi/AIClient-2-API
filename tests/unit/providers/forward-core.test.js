import { describe, test, expect, jest, beforeEach } from '@jest/globals';

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
});
