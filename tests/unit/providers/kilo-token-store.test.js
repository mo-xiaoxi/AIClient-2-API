/**
 * Unit tests for src/providers/kilo/kilo-token-store.js
 * Tests: KiloTokenStore — initialization, getCredentials, getAccessToken, hasToken, validateToken
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const mockRefreshKiloToken = jest.fn();
let mockReadFile;

let KiloTokenStore;

beforeAll(async () => {
    mockReadFile = jest.fn();

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/auth/kilo-oauth.js', () => ({
        __esModule: true,
        refreshKiloToken: mockRefreshKiloToken,
    }));

    await jest.unstable_mockModule('node:fs', () => ({
        __esModule: true,
        promises: {
            readFile: (...args) => mockReadFile(...args),
        },
    }));

    const mod = await import('../../../src/providers/kilo/kilo-token-store.js');
    KiloTokenStore = mod.KiloTokenStore;
});

beforeEach(() => {
    jest.clearAllMocks();
});

const VALID_CREDS = {
    kilocodeToken: 'kilo-token-abc',
    kilocodeOrganizationId: 'org-123',
    kilocodeModel: 'kilo-model-v1',
    email: 'user@kilo.ai',
    type: 'kilo',
};

describe('KiloTokenStore', () => {
    describe('initialize()', () => {
        test('loads credentials from valid file', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_CREDS));
            const store = new KiloTokenStore('/creds/kilo.json');
            await expect(store.initialize()).resolves.toBeUndefined();
            expect(store.hasToken()).toBe(true);
        });

        test('throws when file not found', async () => {
            mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
            const store = new KiloTokenStore('/creds/missing.json');
            await expect(store.initialize()).rejects.toThrow('Kilo credential file not found');
        });

        test('throws when token field missing', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify({ email: 'x@y.com' }));
            const store = new KiloTokenStore('/creds/bad.json');
            await expect(store.initialize()).rejects.toThrow('Kilo credential file not found');
        });

        test('supports generic access_token field as fallback', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify({ access_token: 'generic-tok' }));
            const store = new KiloTokenStore('/creds/generic.json');
            await store.initialize();
            expect(store.getAccessToken()).toBe('generic-tok');
        });
    });

    describe('getCredentials()', () => {
        test('returns token and organizationId', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_CREDS));
            const store = new KiloTokenStore('/creds/kilo.json');
            await store.initialize();
            const creds = store.getCredentials();
            expect(creds.token).toBe('kilo-token-abc');
            expect(creds.organizationId).toBe('org-123');
        });

        test('throws when not initialized', () => {
            const store = new KiloTokenStore('/path');
            expect(() => store.getCredentials()).toThrow('Not authenticated');
        });
    });

    describe('getAccessToken()', () => {
        test('returns kilocodeToken', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_CREDS));
            const store = new KiloTokenStore('/path');
            await store.initialize();
            expect(store.getAccessToken()).toBe('kilo-token-abc');
        });

        test('throws when not initialized', () => {
            const store = new KiloTokenStore('/path');
            expect(() => store.getAccessToken()).toThrow('Not authenticated');
        });
    });

    describe('hasToken()', () => {
        test('returns false before initialize', () => {
            const store = new KiloTokenStore('/path');
            expect(store.hasToken()).toBe(false);
        });

        test('returns true after successful initialize', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_CREDS));
            const store = new KiloTokenStore('/path');
            await store.initialize();
            expect(store.hasToken()).toBe(true);
        });
    });

    describe('validateToken()', () => {
        test('calls refresh function to validate', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_CREDS));
            const store = new KiloTokenStore('/path');
            await store.initialize();
            mockRefreshKiloToken.mockResolvedValueOnce(undefined);
            await expect(store.validateToken()).resolves.toBeUndefined();
            expect(mockRefreshKiloToken).toHaveBeenCalledWith('kilo-token-abc');
        });

        test('throws when validation fails', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_CREDS));
            const store = new KiloTokenStore('/path');
            await store.initialize();
            mockRefreshKiloToken.mockRejectedValueOnce(new Error('token expired'));
            await expect(store.validateToken()).rejects.toThrow('token expired');
        });

        test('deduplicates concurrent validation calls', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_CREDS));
            const store = new KiloTokenStore('/path');
            await store.initialize();

            let resolveValidation;
            mockRefreshKiloToken.mockReturnValueOnce(new Promise(r => { resolveValidation = r; }));

            const p1 = store.validateToken();
            const p2 = store.validateToken();

            resolveValidation(undefined);
            await Promise.all([p1, p2]);
            expect(mockRefreshKiloToken).toHaveBeenCalledTimes(1);
        });
    });
});
