/**
 * Unit tests for src/providers/codebuddy/codebuddy-token-store.js
 * Tests: CodeBuddyTokenStore — init, getValidAccessToken, hasValidToken, getTokens,
 *        getUserId, getDomain, saveTokens, clearTokens, isExpiryDateNear, _doRefresh
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const mockRefreshCodeBuddyToken = jest.fn();
let mockReadFile;
let mockWriteFile;
let mockUnlink;

let CodeBuddyTokenStore;

beforeAll(async () => {
    mockReadFile = jest.fn();
    mockWriteFile = jest.fn().mockResolvedValue(undefined);
    mockUnlink = jest.fn().mockResolvedValue(undefined);

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/auth/codebuddy-oauth.js', () => ({
        __esModule: true,
        refreshCodeBuddyToken: mockRefreshCodeBuddyToken,
    }));

    await jest.unstable_mockModule('node:fs', () => ({
        __esModule: true,
        promises: {
            readFile: (...args) => mockReadFile(...args),
            writeFile: (...args) => mockWriteFile(...args),
            unlink: (...args) => mockUnlink(...args),
        },
    }));

    const mod = await import('../../../src/providers/codebuddy/codebuddy-token-store.js');
    CodeBuddyTokenStore = mod.CodeBuddyTokenStore;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
});

// Tokens valid for 48h (> 24h refresh lead)
const VALID_TOKENS = {
    access_token: 'valid-at',
    refresh_token: 'valid-rt',
    expires_at: Date.now() + 48 * 60 * 60 * 1000,
    user_id: 'user-abc',
    domain: 'www.codebuddy.cn',
};

// Token expires in 2 hours (< 24h refresh lead → needs refresh)
const NEAR_EXPIRY_TOKENS = {
    access_token: 'near-at',
    refresh_token: 'near-rt',
    expires_at: Date.now() + 2 * 60 * 60 * 1000,
    user_id: 'user-def',
    domain: 'www.codebuddy.cn',
};

describe('CodeBuddyTokenStore', () => {
    describe('initialize()', () => {
        test('loads valid token file', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/creds/token.json');
            await expect(store.initialize()).resolves.toBeUndefined();
        });

        test('throws when file not found', async () => {
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
            const store = new CodeBuddyTokenStore('/creds/missing.json');
            await expect(store.initialize()).rejects.toThrow('CodeBuddy token file not found');
        });

        test('back-fills user_id from JWT sub claim', async () => {
            const payload = Buffer.from(JSON.stringify({ sub: 'jwt-user-id' })).toString('base64url');
            const jwtAt = `header.${payload}.sig`;
            const tokensWithoutUserId = { ...VALID_TOKENS, user_id: undefined, access_token: jwtAt };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(tokensWithoutUserId));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            expect(store.getUserId()).toBe('jwt-user-id');
        });
    });

    describe('hasValidToken()', () => {
        test('returns false when not initialized', () => {
            const store = new CodeBuddyTokenStore('/path');
            expect(store.hasValidToken()).toBe(false);
        });

        test('returns true when refresh_token exists', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            expect(store.hasValidToken()).toBe(true);
        });
    });

    describe('getTokens()', () => {
        test('returns null before initialize', () => {
            const store = new CodeBuddyTokenStore('/path');
            expect(store.getTokens()).toBeNull();
        });

        test('returns token object after initialize', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            expect(store.getTokens()).toMatchObject({ access_token: 'valid-at' });
        });
    });

    describe('getValidAccessToken()', () => {
        test('throws when not initialized', async () => {
            const store = new CodeBuddyTokenStore('/path');
            await expect(store.getValidAccessToken()).rejects.toThrow('Not authenticated');
        });

        test('returns token when more than 24h remaining', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            const token = await store.getValidAccessToken();
            expect(token).toBe('valid-at');
        });

        test('refreshes when within 24h refresh lead', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(NEAR_EXPIRY_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();

            const newTokens = { ...VALID_TOKENS, access_token: 'refreshed-at' };
            mockRefreshCodeBuddyToken.mockResolvedValueOnce(newTokens);

            const token = await store.getValidAccessToken();
            expect(token).toBe('refreshed-at');
        });

        test('deduplicates concurrent refresh calls', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(NEAR_EXPIRY_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();

            let resolveRefresh;
            const newTokens = { ...VALID_TOKENS, access_token: 'concurrent-at' };
            mockRefreshCodeBuddyToken.mockReturnValueOnce(new Promise(r => { resolveRefresh = r; }));

            const p1 = store.getValidAccessToken();
            const p2 = store.getValidAccessToken();
            resolveRefresh(newTokens);

            const [t1, t2] = await Promise.all([p1, p2]);
            expect(mockRefreshCodeBuddyToken).toHaveBeenCalledTimes(1);
            expect(t1).toBe('concurrent-at');
            expect(t2).toBe('concurrent-at');
        });
    });

    describe('getUserId() and getDomain()', () => {
        test('getUserId returns user_id from cache', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            expect(store.getUserId()).toBe('user-abc');
        });

        test('getUserId returns empty string when not initialized', () => {
            const store = new CodeBuddyTokenStore('/path');
            expect(store.getUserId()).toBe('');
        });

        test('getDomain returns domain from cache', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            expect(store.getDomain()).toBe('www.codebuddy.cn');
        });

        test('getDomain returns default when not initialized', () => {
            const store = new CodeBuddyTokenStore('/path');
            expect(store.getDomain()).toBe('www.codebuddy.cn');
        });
    });

    describe('saveTokens()', () => {
        test('updates cached tokens and writes to file', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();

            const newTokens = { ...VALID_TOKENS, access_token: 'saved-at' };
            await store.saveTokens(newTokens);

            expect(mockWriteFile).toHaveBeenCalled();
            expect(store.getTokens()?.access_token).toBe('saved-at');
        });
    });

    describe('clearTokens()', () => {
        test('clears cached tokens and deletes file', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();

            await store.clearTokens();
            expect(store.getTokens()).toBeNull();
            expect(mockUnlink).toHaveBeenCalled();
        });
    });

    describe('isExpiryDateNear()', () => {
        test('returns false when no cached tokens', () => {
            const store = new CodeBuddyTokenStore('/path');
            expect(store.isExpiryDateNear()).toBe(false);
        });

        test('returns true when token expires within default 24h', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(NEAR_EXPIRY_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            expect(store.isExpiryDateNear()).toBe(true);
        });

        test('returns false when token has more than 24h remaining', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            expect(store.isExpiryDateNear()).toBe(false);
        });
    });

    describe('_doRefresh()', () => {
        test('throws when no refresh token', async () => {
            const tokensNoRt = { ...VALID_TOKENS, refresh_token: '' };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(tokensNoRt));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();
            await expect(store._doRefresh()).rejects.toThrow('No refresh token available');
        });

        test('retries 3 times then throws on persistent failure', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(NEAR_EXPIRY_TOKENS));
            const store = new CodeBuddyTokenStore('/path');
            await store.initialize();

            mockRefreshCodeBuddyToken.mockRejectedValue(new Error('network error'));
            await expect(store._doRefresh()).rejects.toThrow('Token refresh failed after 3 attempts');
            expect(mockRefreshCodeBuddyToken).toHaveBeenCalledTimes(3);
        });
    });
});
