/**
 * Unit tests for src/providers/copilot/copilot-token-store.js
 * Tests: CopilotTokenStore — init, getValidCopilotJwt, getGitHubAccessToken,
 *        hasGitHubToken, isExpiryDateNear, invalidateJwt, _exchangeForJwt
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

let mockReadFile;
let originalFetch;

let CopilotTokenStore;

beforeAll(async () => {
    mockReadFile = jest.fn();

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/auth/copilot-oauth.js', () => ({
        __esModule: true,
        refreshCopilotToken: jest.fn(),
    }));

    await jest.unstable_mockModule('node:fs', () => ({
        __esModule: true,
        promises: {
            readFile: (...args) => mockReadFile(...args),
        },
    }));

    const mod = await import('../../../src/providers/copilot/copilot-token-store.js');
    CopilotTokenStore = mod.CopilotTokenStore;
});

beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    global.fetch = jest.fn();
});

afterEach(() => {
    global.fetch = originalFetch;
});

const GITHUB_TOKEN = {
    access_token: 'github-access-token',
    token_type: 'bearer',
    scope: 'read:user user:email',
    username: 'octocat',
    type: 'github-copilot',
};

const COPILOT_JWT_RESPONSE = {
    token: 'copilot-jwt-token',
    expires_at: Math.floor((Date.now() + 25 * 60 * 1000) / 1000), // Unix seconds
    endpoints: {
        api: 'https://api.individual.githubcopilot.com',
    },
};

describe('CopilotTokenStore', () => {
    describe('initialize()', () => {
        test('loads GitHub token from file', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/creds/github.json');
            await expect(store.initialize()).resolves.toBeUndefined();
            expect(store.hasGitHubToken()).toBe(true);
        });

        test('throws when file not found', async () => {
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
            const store = new CopilotTokenStore('/creds/missing.json');
            await expect(store.initialize()).rejects.toThrow('Copilot credential file not found');
        });

        test('throws when access_token missing', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify({ username: 'user' }));
            const store = new CopilotTokenStore('/creds/bad.json');
            await expect(store.initialize()).rejects.toThrow('Copilot credential file not found');
        });
    });

    describe('getGitHubAccessToken()', () => {
        test('returns access_token after init', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();
            expect(store.getGitHubAccessToken()).toBe('github-access-token');
        });

        test('throws when not initialized', () => {
            const store = new CopilotTokenStore('/path');
            expect(() => store.getGitHubAccessToken()).toThrow('Not authenticated');
        });
    });

    describe('hasGitHubToken()', () => {
        test('returns false before initialize', () => {
            const store = new CopilotTokenStore('/path');
            expect(store.hasGitHubToken()).toBe(false);
        });

        test('returns true after initialize', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();
            expect(store.hasGitHubToken()).toBe(true);
        });
    });

    describe('getValidCopilotJwt()', () => {
        test('exchanges GitHub token for Copilot JWT', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify(COPILOT_JWT_RESPONSE),
            });

            const jwt = await store.getValidCopilotJwt();
            expect(jwt.token).toBe('copilot-jwt-token');
            expect(jwt.apiEndpoint).toBe('https://api.individual.githubcopilot.com');
        });

        test('returns cached JWT when still fresh', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify(COPILOT_JWT_RESPONSE),
            });

            await store.getValidCopilotJwt(); // first call — exchanges
            await store.getValidCopilotJwt(); // second call — should use cache

            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        test('re-exchanges after invalidateJwt()', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            global.fetch
                .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(COPILOT_JWT_RESPONSE) })
                .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ...COPILOT_JWT_RESPONSE, token: 'new-jwt' }) });

            await store.getValidCopilotJwt();
            store.invalidateJwt();
            const jwt = await store.getValidCopilotJwt();

            expect(jwt.token).toBe('new-jwt');
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        test('throws on non-ok HTTP response', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                text: async () => 'Unauthorized',
            });

            await expect(store.getValidCopilotJwt()).rejects.toThrow('Copilot token exchange failed');
        });

        test('throws when token field empty in response', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ expires_at: 9999999 }), // no token
            });

            await expect(store.getValidCopilotJwt()).rejects.toThrow('empty token');
        });

        test('deduplicates concurrent JWT exchange calls', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            let resolveExchange;
            global.fetch.mockReturnValueOnce(new Promise(r => {
                resolveExchange = () => r({ ok: true, text: async () => JSON.stringify(COPILOT_JWT_RESPONSE) });
            }));

            const p1 = store.getValidCopilotJwt();
            const p2 = store.getValidCopilotJwt();
            resolveExchange();

            const [j1, j2] = await Promise.all([p1, p2]);
            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(j1.token).toBe('copilot-jwt-token');
            expect(j2.token).toBe('copilot-jwt-token');
        });
    });

    describe('isExpiryDateNear()', () => {
        test('returns true when no JWT cached', () => {
            const store = new CopilotTokenStore('/path');
            expect(store.isExpiryDateNear()).toBe(true);
        });

        test('returns false when JWT has plenty of time', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            // Inject a fresh JWT directly
            store._copilotJwt = {
                token: 'jwt',
                expiresAt: Date.now() + 20 * 60 * 1000, // 20 min
                apiEndpoint: 'https://api.individual.githubcopilot.com',
            };

            expect(store.isExpiryDateNear()).toBe(false);
        });
    });

    describe('endpoint validation', () => {
        test('uses default endpoint for untrusted API endpoint', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({
                    token: 'jwt-tok',
                    endpoints: { api: 'https://evil.attacker.com/v1' },
                }),
            });

            const jwt = await store.getValidCopilotJwt();
            expect(jwt.apiEndpoint).toBe('https://api.individual.githubcopilot.com');
        });

        test('uses server-provided expires_at from token response', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(GITHUB_TOKEN));
            const store = new CopilotTokenStore('/path');
            await store.initialize();

            const futureTs = Math.floor((Date.now() + 30 * 60 * 1000) / 1000);
            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ token: 'jwt', expires_at: futureTs }),
            });

            await store.getValidCopilotJwt();
            expect(store._copilotJwt?.expiresAt).toBeCloseTo(futureTs * 1000, -4);
        });
    });
});
