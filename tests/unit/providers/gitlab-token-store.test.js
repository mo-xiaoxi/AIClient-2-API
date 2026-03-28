/**
 * Unit tests for src/providers/gitlab/gitlab-token-store.js
 * Tests: GitLabTokenStore — init, getAccessToken, getBaseUrl, getAuthMethod,
 *        getValidDuoToken, isExpiryDateNear, invalidateDuoToken, hasCredentials,
 *        getModelDetails, refreshOAuthToken, _fetchDirectAccess
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

const mockRefreshGitLabToken = jest.fn();
let mockReadFile;
let mockWriteFile;
let originalFetch;

let GitLabTokenStore;

beforeAll(async () => {
    mockReadFile = jest.fn();
    mockWriteFile = jest.fn().mockResolvedValue(undefined);

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/auth/gitlab-oauth.js', () => ({
        __esModule: true,
        refreshGitLabToken: mockRefreshGitLabToken,
    }));

    await jest.unstable_mockModule('node:fs', () => ({
        __esModule: true,
        promises: {
            readFile: (...args) => mockReadFile(...args),
            writeFile: (...args) => mockWriteFile(...args),
        },
    }));

    const mod = await import('../../../src/providers/gitlab/gitlab-token-store.js');
    GitLabTokenStore = mod.GitLabTokenStore;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    originalFetch = global.fetch;
    global.fetch = jest.fn();
});

afterEach(() => {
    global.fetch = originalFetch;
});

const OAUTH_CREDS = {
    access_token: 'oauth-access-token',
    refresh_token: 'oauth-refresh-token',
    token_type: 'bearer',
    scope: 'api read_user',
    base_url: 'https://gitlab.com',
    auth_method: 'oauth',
    oauth_expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
    username: 'testuser',
};

const PAT_CREDS = {
    personal_access_token: 'glpat-mytoken',
    base_url: 'https://gitlab.example.com',
    auth_method: 'pat',
};

describe('GitLabTokenStore', () => {
    describe('initialize()', () => {
        test('loads OAuth credential file', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/creds/gitlab.json');
            await expect(store.initialize()).resolves.toBeUndefined();
            expect(store.hasCredentials()).toBe(true);
        });

        test('loads PAT credential file', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(PAT_CREDS));
            const store = new GitLabTokenStore('/creds/gitlab-pat.json');
            await store.initialize();
            expect(store.getAccessToken()).toBe('glpat-mytoken');
        });

        test('throws when file not found', async () => {
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
            const store = new GitLabTokenStore('/missing.json');
            await expect(store.initialize()).rejects.toThrow('GitLab credential file not found');
        });

        test('throws when neither access_token nor personal_access_token present', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify({ username: 'user' }));
            const store = new GitLabTokenStore('/bad.json');
            await expect(store.initialize()).rejects.toThrow('GitLab credential file not found');
        });
    });

    describe('getAccessToken()', () => {
        test('returns access_token for OAuth', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getAccessToken()).toBe('oauth-access-token');
        });

        test('returns personal_access_token for PAT', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(PAT_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getAccessToken()).toBe('glpat-mytoken');
        });

        test('throws when not initialized', () => {
            const store = new GitLabTokenStore('/path');
            expect(() => store.getAccessToken()).toThrow('Not authenticated');
        });
    });

    describe('getBaseUrl()', () => {
        test('returns base_url from credentials', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getBaseUrl()).toBe('https://gitlab.com');
        });

        test('returns default gitlab.com when base_url not set', async () => {
            const creds = { ...OAUTH_CREDS };
            delete creds.base_url;
            mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getBaseUrl()).toBe('https://gitlab.com');
        });

        test('normalizes base_url by stripping trailing slash', async () => {
            const creds = { ...OAUTH_CREDS, base_url: 'https://gitlab.company.com/' };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getBaseUrl()).toBe('https://gitlab.company.com');
        });

        test('adds https:// when base_url lacks protocol', async () => {
            const creds = { ...OAUTH_CREDS, base_url: 'gitlab.company.com' };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getBaseUrl()).toBe('https://gitlab.company.com');
        });
    });

    describe('getAuthMethod()', () => {
        test('returns oauth for OAuth credentials', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getAuthMethod()).toBe('oauth');
        });

        test('returns pat for PAT credentials', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(PAT_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getAuthMethod()).toBe('pat');
        });
    });

    describe('hasCredentials()', () => {
        test('returns false before initialize', () => {
            const store = new GitLabTokenStore('/path');
            expect(store.hasCredentials()).toBe(false);
        });

        test('returns true after successful initialize', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.hasCredentials()).toBe(true);
        });
    });

    describe('isExpiryDateNear()', () => {
        test('returns false for PAT (never expires)', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(PAT_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.isExpiryDateNear()).toBe(false);
        });

        test('returns true when oauth_expires_at missing', async () => {
            const creds = { ...OAUTH_CREDS };
            delete creds.oauth_expires_at;
            mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.isExpiryDateNear()).toBe(true);
        });

        test('returns false when token expires far in the future', async () => {
            const creds = {
                ...OAUTH_CREDS,
                oauth_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.isExpiryDateNear()).toBe(false);
        });

        test('returns true when token is expiring soon (< 5 min)', async () => {
            const creds = {
                ...OAUTH_CREDS,
                oauth_expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
            };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.isExpiryDateNear()).toBe(true);
        });
    });

    describe('getModelDetails()', () => {
        test('returns null when model_details not in credentials', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            expect(store.getModelDetails()).toBeNull();
        });

        test('returns modelProvider and modelName when present', async () => {
            const creds = {
                ...OAUTH_CREDS,
                model_details: { model_provider: 'anthropic', model_name: 'claude-3-5-sonnet' },
            };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            const details = store.getModelDetails();
            expect(details.modelProvider).toBe('anthropic');
            expect(details.modelName).toBe('claude-3-5-sonnet');
        });
    });

    describe('refreshOAuthToken()', () => {
        test('returns early for PAT credentials', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(PAT_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            await expect(store.refreshOAuthToken()).resolves.toBeUndefined();
            expect(mockRefreshGitLabToken).not.toHaveBeenCalled();
        });

        test('returns early when no refresh_token available', async () => {
            const creds = { ...OAUTH_CREDS };
            delete creds.refresh_token;
            // Make token near expiry so the no-refresh-token branch is hit
            creds.oauth_expires_at = new Date(Date.now() + 60 * 1000).toISOString();
            mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            await expect(store.refreshOAuthToken()).resolves.toBeUndefined();
            expect(mockRefreshGitLabToken).not.toHaveBeenCalled();
        });

        test('returns early when token is not near expiry', async () => {
            // OAUTH_CREDS already has expires_at = now + 7200s (far future)
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            await expect(store.refreshOAuthToken()).resolves.toBeUndefined();
            expect(mockRefreshGitLabToken).not.toHaveBeenCalled();
        });

        test('refreshes token and persists when near expiry', async () => {
            const nearExpiryCreds = {
                ...OAUTH_CREDS,
                oauth_expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
            };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(nearExpiryCreds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            mockRefreshGitLabToken.mockResolvedValueOnce({
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
                token_type: 'Bearer',
                scope: 'api',
                expires_in: 7200,
                created_at: Math.floor(Date.now() / 1000),
            });

            await store.refreshOAuthToken();
            expect(mockRefreshGitLabToken).toHaveBeenCalledTimes(1);
            expect(store.getAccessToken()).toBe('new-access-token');
            expect(mockWriteFile).toHaveBeenCalled();
        });

        test('calculates expiry using only expires_in when created_at absent', async () => {
            const nearExpiryCreds = {
                ...OAUTH_CREDS,
                oauth_expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
            };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(nearExpiryCreds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            mockRefreshGitLabToken.mockResolvedValueOnce({
                access_token: 'newer-token',
                expires_in: 3600,
                // no created_at
            });

            await store.refreshOAuthToken();
            expect(store.getAccessToken()).toBe('newer-token');
        });

        test('logs warning when persist to disk fails but does not throw', async () => {
            const nearExpiryCreds = {
                ...OAUTH_CREDS,
                oauth_expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
            };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(nearExpiryCreds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            mockRefreshGitLabToken.mockResolvedValueOnce({ access_token: 'persisted-fail-token' });
            mockWriteFile.mockRejectedValueOnce(new Error('EACCES'));

            await expect(store.refreshOAuthToken()).resolves.toBeUndefined();
            expect(store.getAccessToken()).toBe('persisted-fail-token');
        });
    });

    describe('invalidateDuoToken()', () => {
        test('sets _duoGateway to null', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();
            store._duoGateway = { token: 'old-jwt', expiresAt: Date.now() + 99999, baseUrl: 'x', headers: {} };
            store.invalidateDuoToken();
            expect(store._duoGateway).toBeNull();
        });
    });

    describe('getValidDuoToken()', () => {
        test('fetches Duo Gateway token when not cached', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({
                    token: 'duo-jwt-token',
                    base_url: 'https://codesuggestions.gitlab.com',
                    headers: { 'X-Gitlab-Instance-Id': 'abc' },
                    expires_at: Math.floor((Date.now() + 5 * 60 * 1000) / 1000),
                }),
            });

            const result = await store.getValidDuoToken();
            expect(result.token).toBe('duo-jwt-token');
            expect(result.baseUrl).toBe('https://codesuggestions.gitlab.com');
        });

        test('returns cached token when still fresh', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            // Inject a fresh token
            store._duoGateway = {
                token: 'cached-jwt',
                baseUrl: 'https://codesuggestions.gitlab.com',
                headers: {},
                expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
            };

            const result = await store.getValidDuoToken();
            expect(result.token).toBe('cached-jwt');
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('falls back to primary token when gateway token empty', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({
                    token: '', // empty — trigger fallback
                    base_url: '',
                    headers: {},
                }),
            });

            const result = await store.getValidDuoToken();
            expect(result.token).toBe('oauth-access-token'); // primary token
        });

        test('throws when fetch fails', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            global.fetch.mockRejectedValueOnce(new Error('network error'));

            await expect(store.getValidDuoToken()).rejects.toThrow('GitLab direct access network error');
        });

        test('continues fetching Duo token even when OAuth refresh fails', async () => {
            const nearExpiryCreds = {
                ...OAUTH_CREDS,
                oauth_expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
            };
            mockReadFile.mockResolvedValueOnce(JSON.stringify(nearExpiryCreds));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            mockRefreshGitLabToken.mockRejectedValueOnce(new Error('Token refresh failed'));
            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({
                    token: 'duo-jwt-despite-fail',
                    base_url: 'https://codesuggestions.gitlab.com',
                    headers: {},
                }),
            });

            const result = await store.getValidDuoToken();
            expect(result.token).toBe('duo-jwt-despite-fail');
        });

        test('throws when direct_access returns non-ok status', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 403,
                text: async () => 'Forbidden',
            });

            await expect(store.getValidDuoToken()).rejects.toThrow('GitLab direct access failed (403)');
        });

        test('throws when direct_access returns invalid JSON', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => 'not-valid-json',
            });

            await expect(store.getValidDuoToken()).rejects.toThrow('GitLab direct access returned invalid JSON');
        });

        test('stores model_details from direct_access response', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({
                    token: 'duo-jwt-with-model',
                    base_url: 'https://codesuggestions.gitlab.com',
                    headers: {},
                    model_details: {
                        model_provider: 'anthropic',
                        model_name: 'claude-3-5-sonnet',
                    },
                }),
            });

            await store.getValidDuoToken();
            const details = store.getModelDetails();
            expect(details.modelProvider).toBe('anthropic');
            expect(details.modelName).toBe('claude-3-5-sonnet');
        });

        test('deduplicates concurrent getValidDuoToken calls', async () => {
            mockReadFile.mockResolvedValueOnce(JSON.stringify(OAUTH_CREDS));
            const store = new GitLabTokenStore('/path');
            await store.initialize();

            let resolveFetch;
            global.fetch.mockReturnValueOnce(new Promise(r => {
                resolveFetch = () => r({
                    ok: true,
                    text: async () => JSON.stringify({
                        token: 'dedup-jwt',
                        base_url: 'https://cs.gitlab.com',
                        headers: {},
                    }),
                });
            }));

            const p1 = store.getValidDuoToken();
            const p2 = store.getValidDuoToken();
            resolveFetch();

            const [r1, r2] = await Promise.all([p1, p2]);
            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(r1.token).toBe('dedup-jwt');
            expect(r2.token).toBe('dedup-jwt');
        });
    });
});
