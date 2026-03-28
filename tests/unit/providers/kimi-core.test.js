/**
 * Unit tests for src/providers/kimi/kimi-core.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDoRefresh = jest.fn();
const mockGetValidAccessToken = jest.fn();
const mockIsExpiryDateNear = jest.fn(() => false);

await jest.unstable_mockModule('../../../src/providers/kimi/kimi-token-store.js', () => ({
    KimiTokenStore: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        getValidAccessToken: mockGetValidAccessToken,
        isExpiryDateNear: mockIsExpiryDateNear,
        _doRefresh: mockDoRefresh,
        deviceId: 'test-device-id',
    })),
}));

let KimiApiService;

beforeAll(async () => {
    ({ KimiApiService } = await import('../../../src/providers/kimi/kimi-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('KimiApiService', () => {
    test('constructor sets credFilePath from config', () => {
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        expect(svc.credFilePath).toBe('/tmp/kimi.json');
        expect(svc.isInitialized).toBe(false);
    });

    test('initialize sets isInitialized to true', async () => {
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
    });

    test('initialize is idempotent', async () => {
        const { KimiTokenStore } = await import('../../../src/providers/kimi/kimi-token-store.js');
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        await svc.initialize();
        expect(KimiTokenStore).toHaveBeenCalledTimes(1);
    });

    test('listModels returns kimi models', async () => {
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data.every(m => m.id.startsWith('kimi-'))).toBe(true);
        expect(result.data.every(m => m.owned_by === 'moonshot-ai')).toBe(true);
    });

    test('refreshToken skips refresh when token is not near expiry', async () => {
        mockIsExpiryDateNear.mockReturnValue(false);
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockDoRefresh).not.toHaveBeenCalled();
    });

    test('refreshToken calls _doRefresh when token is near expiry', async () => {
        mockIsExpiryDateNear.mockReturnValue(true);
        mockDoRefresh.mockResolvedValue(undefined);
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockDoRefresh).toHaveBeenCalledTimes(1);
    });

    test('isExpiryDateNear returns false when not initialized', () => {
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('getUsageLimits returns empty object', async () => {
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        const result = await svc.getUsageLimits();
        expect(result).toEqual({});
    });

    test('generateContent calls upstream API with stripped prefix', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: 'hi' } }], model: 'k2' }),
        });
        global.fetch = mockFetch;
        mockGetValidAccessToken.mockResolvedValue('test-token');

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        const result = await svc.generateContent('kimi-k2', { messages: [{ role: 'user', content: 'hi' }] });
        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        // prefix stripped: kimi-k2 → k2
        expect(body.model).toBe('k2');
        delete global.fetch;
    });

    test('generateContent throws on API error', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: () => Promise.resolve('Unauthorized'),
        });
        global.fetch = mockFetch;
        mockGetValidAccessToken.mockResolvedValue('bad-token');

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        await expect(svc.generateContent('kimi-k2', { messages: [] })).rejects.toThrow('401');
        delete global.fetch;
    });

    test('generateContent removes _monitorRequestId and _requestBaseUrl from payload', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [], model: 'k2' }),
        });
        global.fetch = mockFetch;
        mockGetValidAccessToken.mockResolvedValue('tok');

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        const body = { messages: [{ role: 'user', content: 'hi' }], _monitorRequestId: 'id', _requestBaseUrl: 'url' };
        await svc.generateContent('kimi-k2', body);

        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(sentBody._monitorRequestId).toBeUndefined();
        expect(sentBody._requestBaseUrl).toBeUndefined();
        delete global.fetch;
    });

    test('generateContentStream yields parsed SSE chunks', async () => {
        mockGetValidAccessToken.mockResolvedValue('stream-token');

        const chunk1 = JSON.stringify({ choices: [{ delta: { content: 'hello' } }], model: 'k2' });
        const chunk2 = JSON.stringify({ choices: [{ delta: { content: ' world' } }], model: 'k2' });
        const sseData = `data: ${chunk1}\n\ndata: ${chunk2}\n\ndata: [DONE]\n\n`;

        const encoder = new TextEncoder();
        let readCount = 0;
        const chunks = [encoder.encode(sseData)];

        const mockReader = {
            read: jest.fn().mockImplementation(() => {
                if (readCount < chunks.length) {
                    return Promise.resolve({ done: false, value: chunks[readCount++] });
                }
                return Promise.resolve({ done: true, value: undefined });
            }),
            releaseLock: jest.fn(),
        };

        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            body: { getReader: () => mockReader },
        });
        global.fetch = mockFetch;

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();

        const chunks2 = [];
        for await (const chunk of svc.generateContentStream('kimi-k2', { messages: [{ role: 'user', content: 'hi' }] })) {
            chunks2.push(chunk);
        }

        expect(chunks2.length).toBe(2);
        // Model name restored to original
        expect(chunks2[0].model).toBe('kimi-k2');
        delete global.fetch;
    });

    test('generateContentStream skips malformed chunks', async () => {
        mockGetValidAccessToken.mockResolvedValue('stream-token');

        const sseData = 'data: not-json\n\ndata: {"choices":[],"model":"k2"}\n\ndata: [DONE]\n\n';
        const encoder = new TextEncoder();
        let readCount = 0;
        const chunks = [encoder.encode(sseData)];

        const mockReader = {
            read: jest.fn().mockImplementation(() => {
                if (readCount < chunks.length) {
                    return Promise.resolve({ done: false, value: chunks[readCount++] });
                }
                return Promise.resolve({ done: true, value: undefined });
            }),
            releaseLock: jest.fn(),
        };

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: { getReader: () => mockReader },
        });

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();

        const results = [];
        for await (const c of svc.generateContentStream('kimi-k2', { messages: [{ role: 'user', content: 'hi' }] })) {
            results.push(c);
        }

        // Only valid JSON chunk should be yielded (not-json is skipped)
        expect(results.length).toBe(1);
        delete global.fetch;
    });

    test('generateContentStream throws on API error response', async () => {
        mockGetValidAccessToken.mockResolvedValue('tok');

        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Internal Server Error'),
        });

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();

        await expect(async () => {
            for await (const _ of svc.generateContentStream('kimi-k2', { messages: [{ role: 'user', content: 'hi' }] })) {}
        }).rejects.toThrow('500');

        delete global.fetch;
    });

    test('generateContentStream removes internal fields from payload', async () => {
        mockGetValidAccessToken.mockResolvedValue('tok');

        const encoder = new TextEncoder();
        let done = false;
        const mockReader = {
            read: jest.fn().mockImplementation(() => {
                if (!done) {
                    done = true;
                    return Promise.resolve({ done: false, value: encoder.encode('data: [DONE]\n\n') });
                }
                return Promise.resolve({ done: true, value: undefined });
            }),
            releaseLock: jest.fn(),
        };

        let capturedBody;
        global.fetch = jest.fn().mockImplementation((url, opts) => {
            capturedBody = JSON.parse(opts.body);
            return Promise.resolve({ ok: true, body: { getReader: () => mockReader } });
        });

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();

        const body = {
            messages: [{ role: 'user', content: 'hi' }],
            _monitorRequestId: 'req-id',
            _requestBaseUrl: 'https://x.com',
        };

        for await (const _ of svc.generateContentStream('kimi-k2', body)) {}

        expect(capturedBody._monitorRequestId).toBeUndefined();
        expect(capturedBody._requestBaseUrl).toBeUndefined();
        expect(capturedBody.stream).toBe(true);
        delete global.fetch;
    });

    test('forceRefreshToken calls _doRefresh even when not near expiry', async () => {
        mockDoRefresh.mockResolvedValue(undefined);
        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        await svc.forceRefreshToken();
        expect(mockDoRefresh).toHaveBeenCalledTimes(1);
    });

    test('generateContent response model restored to original name', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [], model: 'k2-thinking' }),
        });
        global.fetch = mockFetch;
        mockGetValidAccessToken.mockResolvedValue('tok');

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        const result = await svc.generateContent('kimi-k2-thinking', { messages: [{ role: 'user', content: 'hi' }] });
        expect(result.model).toBe('kimi-k2-thinking');
        delete global.fetch;
    });

    test('stripKimiPrefix: model without kimi- prefix is returned as-is', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [], model: 'claude' }),
        });
        global.fetch = mockFetch;
        mockGetValidAccessToken.mockResolvedValue('tok');

        const svc = new KimiApiService({ uuid: 'u1', KIMI_OAUTH_CREDS_FILE_PATH: '/tmp/kimi.json' });
        await svc.initialize();
        await svc.generateContent('claude', { messages: [{ role: 'user', content: 'hi' }] });

        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        // no stripping: 'claude' → 'claude'
        expect(sentBody.model).toBe('claude');
        delete global.fetch;
    });
});
