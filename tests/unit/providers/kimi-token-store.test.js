/**
 * Unit tests for src/providers/kimi/kimi-token-store.js
 * Tests: KimiTokenStore — initialization, getValidAccessToken, isExpiryDateNear, _doRefresh
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const mockRefreshKimiToken = jest.fn();
let mockReadFile;
let mockWriteFile;

let KimiTokenStore;

beforeAll(async () => {
    mockReadFile = jest.fn();
    mockWriteFile = jest.fn().mockResolvedValue(undefined);

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/auth/kimi-oauth.js', () => ({
        __esModule: true,
        refreshKimiToken: mockRefreshKimiToken,
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        promises: {
            readFile: (...args) => mockReadFile(...args),
            writeFile: (...args) => mockWriteFile(...args),
        },
    }));

    const mod = await import('../../../src/providers/kimi/kimi-token-store.js');
    KimiTokenStore = mod.KimiTokenStore;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
});

const VALID_TOKENS = {
    access_token: 'valid-at',
    refresh_token: 'valid-rt',
    expires_at: Date.now() + 60 * 60 * 1000, // 1 hour from now
    device_id: 'device-123',
};

const EXPIRING_TOKENS = {
    access_token: 'expiring-at',
    refresh_token: 'expiring-rt',
    expires_at: Date.now() + 60 * 1000, // 1 minute (< 5 min buffer)
    device_id: 'device-123',
};

const EXPIRED_TOKENS = {
    access_token: 'expired-at',
    refresh_token: 'expired-rt',
    expires_at: Date.now() - 1000,
    device_id: 'device-123',
};

describe('KimiTokenStore', () => {
    describe('initialize()', () => {
        test('loads valid token file successfully', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new KimiTokenStore('/creds/token.json');
            await expect(store.initialize()).resolves.toBeUndefined();
        });

        test('throws when file does not exist', async () => {
            mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
            const store = new KimiTokenStore('/creds/missing.json');
            await expect(store.initialize()).rejects.toThrow('Token file not found');
        });

        test('throws when file contains invalid JSON', async () => {
            mockReadFile.mockResolvedValueOnce('not-json');
            const store = new KimiTokenStore('/creds/bad.json');
            await expect(store.initialize()).rejects.toThrow('Token file not found');
        });
    });

    describe('getValidAccessToken()', () => {
        test('throws when not initialized', async () => {
            const store = new KimiTokenStore('/path');
            await expect(store.getValidAccessToken()).rejects.toThrow('Not authenticated');
        });

        test('returns cached token when still valid', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new KimiTokenStore('/path');
            await store.initialize();
            const token = await store.getValidAccessToken();
            expect(token).toBe('valid-at');
        });

        test('refreshes when token is expiring soon (< 5 min)', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(EXPIRING_TOKENS));
            const store = new KimiTokenStore('/path');
            await store.initialize();

            const newTokens = { ...VALID_TOKENS, access_token: 'refreshed-at' };
            mockRefreshKimiToken.mockResolvedValueOnce(newTokens);

            const token = await store.getValidAccessToken();
            expect(token).toBe('refreshed-at');
            expect(mockRefreshKimiToken).toHaveBeenCalled();
        });

        test('returns current token when no refresh_token available', async () => {
            const noRefreshTokens = { access_token: 'at', expires_at: Date.now() + 1000 };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(noRefreshTokens));
            const store = new KimiTokenStore('/path');
            await store.initialize();
            const token = await store.getValidAccessToken();
            expect(token).toBe('at');
        });

        test('deduplicates concurrent refresh calls', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(EXPIRING_TOKENS));
            const store = new KimiTokenStore('/path');
            await store.initialize();

            const newTokens = { ...VALID_TOKENS, access_token: 'refreshed-at' };
            let resolveRefresh;
            mockRefreshKimiToken.mockReturnValueOnce(new Promise(r => { resolveRefresh = r; }));

            const p1 = store.getValidAccessToken();
            const p2 = store.getValidAccessToken();

            resolveRefresh(newTokens);

            const [t1, t2] = await Promise.all([p1, p2]);
            expect(mockRefreshKimiToken).toHaveBeenCalledTimes(1);
            expect(t1).toBe('refreshed-at');
            expect(t2).toBe('refreshed-at');
        });
    });

    describe('deviceId getter', () => {
        test('returns device_id from cached tokens', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new KimiTokenStore('/path');
            await store.initialize();
            expect(store.deviceId).toBe('device-123');
        });

        test('returns empty string when not initialized', () => {
            const store = new KimiTokenStore('/path');
            expect(store.deviceId).toBe('');
        });
    });

    describe('isExpiryDateNear()', () => {
        test('returns false when expires_at not set', () => {
            const store = new KimiTokenStore('/path');
            expect(store.isExpiryDateNear()).toBe(false);
        });

        test('returns true when token expires within default 5 min', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(EXPIRING_TOKENS));
            const store = new KimiTokenStore('/path');
            await store.initialize();
            expect(store.isExpiryDateNear()).toBe(true);
        });

        test('returns false when token has plenty of time', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new KimiTokenStore('/path');
            await store.initialize();
            expect(store.isExpiryDateNear()).toBe(false);
        });
    });

    describe('_doRefresh()', () => {
        test('retries up to 3 times on failure', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(EXPIRING_TOKENS));
            const store = new KimiTokenStore('/path');
            await store.initialize();

            mockRefreshKimiToken.mockRejectedValue(new Error('network error'));
            // Should not throw — logs error and returns without updating
            await store._doRefresh();
            expect(mockRefreshKimiToken).toHaveBeenCalledTimes(3);
        });

        test('saves refreshed tokens to file on success', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(EXPIRING_TOKENS));
            const store = new KimiTokenStore('/path');
            await store.initialize();

            const newTokens = { ...VALID_TOKENS, access_token: 'new-at' };
            mockRefreshKimiToken.mockResolvedValueOnce(newTokens);

            await store._doRefresh();
            expect(mockWriteFile).toHaveBeenCalled();
        });
    });
});
