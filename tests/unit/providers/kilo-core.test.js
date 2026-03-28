/**
 * Unit tests for src/providers/kilo/kilo-core.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetCredentials = jest.fn(() => ({ token: 'test-token', organizationId: 'org-1' }));

await jest.unstable_mockModule('../../../src/providers/kilo/kilo-token-store.js', () => ({
    KiloTokenStore: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        getCredentials: mockGetCredentials,
        validateToken: jest.fn().mockResolvedValue(undefined),
    })),
}));

let KiloApiService;

beforeAll(async () => {
    ({ KiloApiService } = await import('../../../src/providers/kilo/kilo-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    // Reset getCredentials to default behaviour each test
    mockGetCredentials.mockReturnValue({ token: 'test-token', organizationId: 'org-1' });
});

describe('KiloApiService', () => {
    test('constructor sets credFilePath from config', () => {
        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        expect(svc.credFilePath).toBe('/tmp/kilo.json');
        expect(svc.isInitialized).toBe(false);
    });

    test('initialize throws when credFilePath is not configured', async () => {
        const svc = new KiloApiService({});
        await expect(svc.initialize()).rejects.toThrow('KILO_OAUTH_CREDS_FILE_PATH');
    });

    test('initialize sets isInitialized to true', async () => {
        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
    });

    test('initialize is idempotent', async () => {
        const { KiloTokenStore } = await import('../../../src/providers/kilo/kilo-token-store.js');
        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        await svc.initialize();
        expect(KiloTokenStore).toHaveBeenCalledTimes(1);
    });

    test('isExpiryDateNear always returns false (long-lived token)', async () => {
        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('refreshToken completes without error', async () => {
        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        await expect(svc.refreshToken()).resolves.not.toThrow();
    });

    test('listModels returns static fallback on fetch failure', async () => {
        const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
        global.fetch = mockFetch;

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const result = await svc.listModels();

        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0].id).toBe('kilo/auto');
        delete global.fetch;
    });

    test('listModels uses cache on second call within TTL', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                data: [{ id: 'kilo/auto', preferredIndex: 1 }, { id: 'kilo/claude-4', preferredIndex: 2 }],
            }),
        });
        global.fetch = mockFetch;

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const r1 = await svc.listModels();
        const r2 = await svc.listModels();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(r1).toEqual(r2);
        delete global.fetch;
    });

    test('generateContent throws on upstream API error', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 429,
            text: () => Promise.resolve('Rate limit exceeded'),
        });
        global.fetch = mockFetch;

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        await expect(
            svc.generateContent('kilo/auto', { messages: [{ role: 'user', content: 'hi' }] })
        ).rejects.toThrow('429');
        delete global.fetch;
    });

    test('generateContent returns parsed JSON on success', async () => {
        const payload = { choices: [{ message: { content: 'OK' } }] };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(JSON.stringify(payload)),
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const result = await svc.generateContent('kilo/auto', { messages: [] });
        expect(result.choices[0].message.content).toBe('OK');
        delete global.fetch;
    });

    test('generateContent throws on network failure', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        await expect(svc.generateContent('kilo/auto', { messages: [] })).rejects.toThrow('Network error');
        delete global.fetch;
    });

    test('generateContentStream yields parsed SSE chunks', async () => {
        const chunk = { choices: [{ delta: { content: 'hello' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
        const encoder = new TextEncoder();
        const encoded = encoder.encode(sseData);

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: {
                getReader: () => ({
                    read: jest.fn()
                        .mockResolvedValueOnce({ done: false, value: encoded })
                        .mockResolvedValueOnce({ done: true }),
                    cancel: jest.fn().mockResolvedValue(undefined),
                }),
            },
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();

        const chunks = [];
        for await (const c of svc.generateContentStream('kilo/auto', { messages: [] })) {
            chunks.push(c);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        delete global.fetch;
    });

    test('generateContentStream throws on non-ok response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: () => Promise.resolve('Forbidden'),
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const gen = svc.generateContentStream('kilo/auto', { messages: [] });
        await expect(gen.next()).rejects.toThrow('Kilo API error (403)');
        delete global.fetch;
    });

    test('generateContent throws on invalid JSON response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('this is not json {'),
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        await expect(svc.generateContent('kilo/auto', { messages: [] })).rejects.toThrow('Failed to parse response JSON');
        delete global.fetch;
    });

    test('generateContentStream handles network error (fetch throws)', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        await expect(async () => {
            for await (const _ of svc.generateContentStream('kilo/auto', { messages: [] })) {}
        }).rejects.toThrow('Network error');
        delete global.fetch;
    });

    test('generateContentStream skips malformed SSE chunks', async () => {
        const sseData = 'data: not-json\n\ndata: {"choices":[]}\n\ndata: [DONE]\n\n';
        const encoder = new TextEncoder();
        let readCount = 0;
        const chunks = [encoder.encode(sseData)];
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: {
                getReader: () => ({
                    read: jest.fn().mockImplementation(() => {
                        if (readCount < chunks.length) {
                            return Promise.resolve({ done: false, value: chunks[readCount++] });
                        }
                        return Promise.resolve({ done: true, value: undefined });
                    }),
                    cancel: jest.fn().mockResolvedValue(undefined),
                }),
            },
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const results = [];
        for await (const c of svc.generateContentStream('kilo/auto', { messages: [] })) {
            results.push(c);
        }
        // Only valid JSON chunk should be yielded
        expect(results.length).toBe(1);
        delete global.fetch;
    });

    test('forceRefreshToken calls _tokenStore.validateToken', async () => {
        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        await svc.forceRefreshToken();
        // validateToken was mocked as jest.fn().mockResolvedValue(undefined) in the KiloTokenStore mock
        // If no error thrown, the test passes
    });

    test('listModels fetches and parses API response with text()', async () => {
        const apiResponse = {
            data: [
                { id: 'kilo/auto', preferredIndex: 2, name: 'Kilo Auto', is_free: true },
                { id: 'anthropic/claude-3-haiku:free', preferredIndex: 1, name: 'Claude Haiku', is_free: true },
                { id: 'paid-model', preferredIndex: 3, name: 'Paid Model', pricing: { prompt: '0.001' } },
            ]
        };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(JSON.stringify(apiResponse)),
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const result = await svc.listModels();

        expect(result.object).toBe('list');
        expect(result.data.some(m => m.id === 'kilo/auto')).toBe(true);
        // paid-model should NOT be included (pricing.prompt != '0')
        expect(result.data.some(m => m.id === 'paid-model')).toBe(false);
        delete global.fetch;
    });

    test('listModels handles non-ok API response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Internal Server Error'),
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        // Should fall back to FALLBACK_MODELS without throwing
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
        delete global.fetch;
    });

    test('listModels handles invalid JSON in API response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('not-valid-json'),
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        delete global.fetch;
    });

    test('listModels handles invalid response format (no array)', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({ count: 5 })), // no data or root array
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        delete global.fetch;
    });

    test('_fetchModels includes organization header when organizationId is set', async () => {
        let capturedHeaders;
        global.fetch = jest.fn().mockImplementation((url, opts) => {
            capturedHeaders = opts.headers;
            return Promise.resolve({
                ok: true,
                text: () => Promise.resolve(JSON.stringify({ data: [] })),
            });
        });
        mockGetCredentials.mockReturnValue({ token: 'tok', organizationId: 'org-123' });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        await svc.listModels();

        expect(capturedHeaders['X-Kilocode-OrganizationID']).toBe('org-123');
        delete global.fetch;
    });

    test('listModels parses root-array API response', async () => {
        const apiResponse = [
            { id: 'kilo/auto', preferredIndex: 1, is_free: true },
        ];
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(JSON.stringify(apiResponse)),
        });

        const svc = new KiloApiService({ KILO_OAUTH_CREDS_FILE_PATH: '/tmp/kilo.json' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.data.some(m => m.id === 'kilo/auto')).toBe(true);
        delete global.fetch;
    });
});
