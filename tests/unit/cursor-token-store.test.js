/**
 * Unit tests for cursor-token-store.js
 *
 * Tests: CursorTokenStore — initialization, token caching, expiry detection,
 *        concurrent refresh deduplication, refresh failure handling.
 *
 * NOTE: Must use jest.mock() (hoisted by babel-jest) instead of jest.unstable_mockModule()
 * because this project's transitive import chain uses import.meta.url which fails under
 * babel-jest. Variables referenced in jest.mock factories must be prefixed with "mock".
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';

// jest.mock is hoisted by babel-jest — all factories must be self-contained
jest.mock('../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Variable name MUST start with "mock" for jest.mock hoisting to allow external reference
let mockRefreshFn;
jest.mock('../../src/auth/cursor-oauth.js', () => ({
    __esModule: true,
    refreshCursorToken: (...args) => mockRefreshFn(...args),
}));

import { CursorTokenStore } from '../../src/providers/cursor/cursor-token-store.js';

// ============================================================================
// Test helpers
// ============================================================================

function makeTokens(expiresInMs) {
    return {
        access_token: `at-${Date.now()}`,
        refresh_token: `rt-${Date.now()}`,
        expires_at: Date.now() + expiresInMs,
    };
}

const VALID_TOKENS = {
    access_token: 'valid-access-token',
    refresh_token: 'valid-refresh-token',
    expires_at: Date.now() + 3600 * 1000,
};

const EXPIRED_TOKENS = {
    access_token: 'expired-access-token',
    refresh_token: 'expired-refresh-token',
    expires_at: Date.now() - 1000,
};

// ============================================================================
// Tests
// ============================================================================

describe('CursorTokenStore', () => {
    let store;
    let readFileSpy;
    let writeFileSpy;
    let unlinkSpy;

    beforeEach(() => {
        mockRefreshFn = jest.fn();
        store = new CursorTokenStore('/tmp/test-cursor-tokens.json');
        readFileSpy = jest.spyOn(fs, 'readFile');
        writeFileSpy = jest.spyOn(fs, 'writeFile');
        unlinkSpy = jest.spyOn(fs, 'unlink');
    });

    afterEach(() => {
        readFileSpy.mockRestore();
        writeFileSpy.mockRestore();
        unlinkSpy.mockRestore();
    });

    // ---------- constructor ----------

    describe('constructor', () => {
        test('initializes with credFilePath and null state', () => {
            expect(store.credFilePath).toBe('/tmp/test-cursor-tokens.json');
            expect(store._cached).toBeNull();
            expect(store._refreshPromise).toBeNull();
        });
    });

    // ---------- initialize ----------

    describe('initialize', () => {
        test('loads tokens from file', async () => {
            readFileSpy.mockResolvedValue(JSON.stringify(VALID_TOKENS));
            await store.initialize();
            expect(store._cached).toEqual(VALID_TOKENS);
        });

        test('throws on missing file', async () => {
            readFileSpy.mockRejectedValue(new Error('ENOENT'));
            await expect(store.initialize()).rejects.toThrow('Cursor token file not found or invalid');
            expect(store._cached).toBeNull();
        });

        test('throws on invalid JSON', async () => {
            readFileSpy.mockResolvedValue('not valid json{{{');
            await expect(store.initialize()).rejects.toThrow();
        });
    });

    // ---------- hasValidToken ----------

    describe('hasValidToken', () => {
        test('returns true when refresh_token exists', () => {
            store._cached = VALID_TOKENS;
            expect(store.hasValidToken()).toBe(true);
        });

        test('returns false when _cached is null', () => {
            expect(store.hasValidToken()).toBe(false);
        });

        test('returns false when refresh_token is empty', () => {
            store._cached = { ...VALID_TOKENS, refresh_token: '' };
            expect(store.hasValidToken()).toBe(false);
        });
    });

    // ---------- getTokens ----------

    describe('getTokens', () => {
        test('returns cached tokens', () => {
            store._cached = VALID_TOKENS;
            expect(store.getTokens()).toEqual(VALID_TOKENS);
        });

        test('returns null when not initialized', () => {
            expect(store.getTokens()).toBeNull();
        });
    });

    // ---------- getValidAccessToken ----------

    describe('getValidAccessToken', () => {
        test('throws if not authenticated', async () => {
            await expect(store.getValidAccessToken()).rejects.toThrow('Not authenticated');
        });

        test('returns cached token if not expired', async () => {
            store._cached = { ...VALID_TOKENS };
            const token = await store.getValidAccessToken();
            expect(token).toBe(VALID_TOKENS.access_token);
        });

        test('triggers refresh when token is expired', async () => {
            store._cached = { ...EXPIRED_TOKENS };
            const newTokens = makeTokens(3600 * 1000);
            mockRefreshFn.mockResolvedValue(newTokens);
            writeFileSpy.mockResolvedValue();

            const token = await store.getValidAccessToken();
            expect(token).toBe(newTokens.access_token);
            expect(mockRefreshFn).toHaveBeenCalledWith('expired-refresh-token');
        });

        test('deduplicates concurrent refresh calls', async () => {
            store._cached = { ...EXPIRED_TOKENS };
            const newTokens = makeTokens(3600 * 1000);

            let resolveRefresh;
            mockRefreshFn.mockImplementation(() => new Promise((r) => { resolveRefresh = r; }));
            writeFileSpy.mockResolvedValue();

            const p1 = store.getValidAccessToken();
            const p2 = store.getValidAccessToken();

            await new Promise((r) => setTimeout(r, 10));
            resolveRefresh(newTokens);

            const [t1, t2] = await Promise.all([p1, p2]);
            expect(t1).toBe(newTokens.access_token);
            expect(t2).toBe(newTokens.access_token);
            expect(mockRefreshFn).toHaveBeenCalledTimes(1);
        });
    });

    // ---------- saveTokens ----------

    describe('saveTokens', () => {
        test('saves to memory and file', async () => {
            writeFileSpy.mockResolvedValue();
            await store.saveTokens(VALID_TOKENS);
            expect(store._cached).toEqual(VALID_TOKENS);
            expect(writeFileSpy).toHaveBeenCalledWith(
                '/tmp/test-cursor-tokens.json',
                JSON.stringify(VALID_TOKENS, null, 2),
                'utf8'
            );
        });

        test('still updates memory even if file write fails', async () => {
            writeFileSpy.mockRejectedValue(new Error('write error'));
            await store.saveTokens(VALID_TOKENS);
            expect(store._cached).toEqual(VALID_TOKENS);
        });
    });

    // ---------- clearTokens ----------

    describe('clearTokens', () => {
        test('clears memory and deletes file', async () => {
            store._cached = { ...VALID_TOKENS };
            unlinkSpy.mockResolvedValue();
            await store.clearTokens();
            expect(store._cached).toBeNull();
            expect(unlinkSpy).toHaveBeenCalledWith('/tmp/test-cursor-tokens.json');
        });

        test('handles file not existing gracefully', async () => {
            store._cached = { ...VALID_TOKENS };
            unlinkSpy.mockRejectedValue(new Error('ENOENT'));
            await store.clearTokens();
            expect(store._cached).toBeNull();
        });
    });

    // ---------- isExpiryDateNear ----------

    describe('isExpiryDateNear', () => {
        test('returns false when _cached is null', () => {
            expect(store.isExpiryDateNear()).toBe(false);
        });

        test('returns true when within 5-minute window', () => {
            store._cached = { ...VALID_TOKENS, expires_at: Date.now() + 2 * 60 * 1000 };
            expect(store.isExpiryDateNear(5)).toBe(true);
        });

        test('returns false when expiry is far away', () => {
            store._cached = { ...VALID_TOKENS };
            expect(store.isExpiryDateNear(5)).toBe(false);
        });

        test('uses custom nearMinutes parameter', () => {
            store._cached = { ...VALID_TOKENS, expires_at: Date.now() + 8 * 60 * 1000 };
            expect(store.isExpiryDateNear(10)).toBe(true);
            expect(store.isExpiryDateNear(5)).toBe(false);
        });
    });

    // ---------- _doRefresh ----------

    describe('_doRefresh', () => {
        test('throws when no refresh_token', async () => {
            store._cached = { access_token: 'x', refresh_token: '', expires_at: 0 };
            await expect(store._doRefresh()).rejects.toThrow('No refresh token available');
        });

        test('retries 3 times on failure then clears tokens', async () => {
            store._cached = { ...EXPIRED_TOKENS };
            mockRefreshFn.mockRejectedValue(new Error('network error'));
            unlinkSpy.mockResolvedValue();

            await expect(store._doRefresh()).rejects.toThrow('Token refresh failed after 3 attempts');
            expect(mockRefreshFn).toHaveBeenCalledTimes(3);
            expect(store._cached).toBeNull();
        }, 15000);

        test('succeeds on second retry', async () => {
            store._cached = { ...EXPIRED_TOKENS };
            const newTokens = makeTokens(3600 * 1000);
            mockRefreshFn
                .mockRejectedValueOnce(new Error('fail 1'))
                .mockResolvedValueOnce(newTokens);
            writeFileSpy.mockResolvedValue();

            await store._doRefresh();
            expect(store._cached).toEqual(newTokens);
            expect(mockRefreshFn).toHaveBeenCalledTimes(2);
        }, 10000);
    });
});
