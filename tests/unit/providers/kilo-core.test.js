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
});
