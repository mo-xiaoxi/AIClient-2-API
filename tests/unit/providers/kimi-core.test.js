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
});
