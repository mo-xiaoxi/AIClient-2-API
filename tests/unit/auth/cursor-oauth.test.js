/**
 * Unit tests for cursor-oauth.js
 *
 * Tests: generateCursorAuthParams, refreshCursorToken, handleCursorOAuth.
 * ESM: jest.unstable_mockModule + dynamic import (jest.mock → require is not defined).
 */

import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';

let generateCursorAuthParams;
let refreshCursorToken;
let handleCursorOAuth;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        },
    }));
    await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
        __esModule: true,
        broadcastEvent: () => {},
    }));
    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        __esModule: true,
        autoLinkProviderConfigs: () => Promise.resolve(),
    }));
    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        __esModule: true,
        CONFIG: { someKey: 'someValue' },
    }));
    const mod = await import('../../../src/auth/cursor-oauth.js');
    generateCursorAuthParams = mod.generateCursorAuthParams;
    refreshCursorToken = mod.refreshCursorToken;
    handleCursorOAuth = mod.handleCursorOAuth;
});

// ============================================================================
// Tests
// ============================================================================

describe('generateCursorAuthParams', () => {
    test('returns verifier, challenge, uuid, and loginUrl', async () => {
        const params = await generateCursorAuthParams();

        expect(params.verifier).toBeDefined();
        expect(typeof params.verifier).toBe('string');
        expect(params.verifier.length).toBeGreaterThan(0);

        expect(params.challenge).toBeDefined();
        expect(typeof params.challenge).toBe('string');
        expect(params.challenge.length).toBeGreaterThan(0);

        expect(params.uuid).toBeDefined();
        expect(params.uuid).toMatch(/^[0-9a-f-]+$/i);

        expect(params.loginUrl).toContain('https://cursor.com/loginDeepControl');
        expect(params.loginUrl).toContain(`challenge=${params.challenge}`);
        expect(params.loginUrl).toContain(`uuid=${params.uuid}`);
    });

    test('generates unique values each call', async () => {
        const p1 = await generateCursorAuthParams();
        const p2 = await generateCursorAuthParams();
        expect(p1.uuid).not.toBe(p2.uuid);
        expect(p1.verifier).not.toBe(p2.verifier);
    });

    test('loginUrl contains required parameters', async () => {
        const params = await generateCursorAuthParams();
        const url = new URL(params.loginUrl);
        expect(url.searchParams.get('challenge')).toBe(params.challenge);
        expect(url.searchParams.get('uuid')).toBe(params.uuid);
        expect(url.searchParams.get('mode')).toBe('login');
        expect(url.searchParams.get('redirectTarget')).toBe('cli');
    });
});

describe('refreshCursorToken', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterAll(() => {
        global.fetch = originalFetch;
    });

    function makeFakeJwt(expSeconds) {
        const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
        return `header.${payload}.signature`;
    }

    test('sends refresh request with correct headers', async () => {
        const futureExp = Math.floor(Date.now() / 1000) + 3600;
        const fakeJwt = makeFakeJwt(futureExp);

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ accessToken: fakeJwt, refreshToken: 'new-refresh-token' }),
        });

        await refreshCursorToken('old-refresh-token');

        expect(global.fetch).toHaveBeenCalledWith(
            'https://api2.cursor.sh/auth/exchange_user_api_key',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer old-refresh-token',
                    'Content-Type': 'application/json',
                }),
                body: '{}',
            })
        );
    });

    test('returns tokens with expires_at derived from JWT exp', async () => {
        const futureExp = Math.floor(Date.now() / 1000) + 3600;
        const fakeJwt = makeFakeJwt(futureExp);

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ accessToken: fakeJwt, refreshToken: 'new-rt' }),
        });

        const result = await refreshCursorToken('rt');

        expect(result.access_token).toBe(fakeJwt);
        expect(result.refresh_token).toBe('new-rt');
        expect(typeof result.expires_at).toBe('number');
        expect(result.expires_at).toBe(futureExp * 1000 - 5 * 60 * 1000);
    });

    test('uses original refresh_token if response lacks one', async () => {
        const fakeJwt = makeFakeJwt(Math.floor(Date.now() / 1000) + 3600);

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ accessToken: fakeJwt }),
        });

        const result = await refreshCursorToken('keep-this-rt');
        expect(result.refresh_token).toBe('keep-this-rt');
    });

    test('throws on HTTP error', async () => {
        global.fetch.mockResolvedValue({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        });

        await expect(refreshCursorToken('bad-rt')).rejects.toThrow('Cursor token refresh failed (401)');
    });

    test('throws if response has no access_token', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });

        await expect(refreshCursorToken('rt')).rejects.toThrow('missing access_token');
    });

    test('handles snake_case response fields', async () => {
        const fakeJwt = makeFakeJwt(Math.floor(Date.now() / 1000) + 3600);

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: fakeJwt, refresh_token: 'snake-rt' }),
        });

        const result = await refreshCursorToken('rt');
        expect(result.access_token).toBe(fakeJwt);
        expect(result.refresh_token).toBe('snake-rt');
    });
});

describe('handleCursorOAuth', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterAll(() => {
        global.fetch = originalFetch;
    });

    test('returns authUrl and authInfo', async () => {
        global.fetch.mockResolvedValue({ status: 404 });

        const result = await handleCursorOAuth({});

        expect(result.authUrl).toContain('https://cursor.com/loginDeepControl');
        expect(result.authInfo.provider).toBe('cursor-oauth');
        expect(result.authInfo.method).toBe('pkce-polling');
        expect(result.authInfo.uuid).toBeDefined();
    });

    test('starts background polling (fire-and-forget)', async () => {
        global.fetch.mockRejectedValue(new Error('network error'));

        const result = await handleCursorOAuth({});
        expect(result.authUrl).toBeDefined();

        await new Promise((r) => setTimeout(r, 200));
    });
});
