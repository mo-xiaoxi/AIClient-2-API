/**
 * Unit tests for auth/gitlab-oauth.js
 * Tests: handleGitLabOAuth, refreshGitLabToken
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

let handleGitLabOAuth;
let refreshGitLabToken;

let mockBroadcastEvent;
let mockAutoLinkProviderConfigs;
let mockFsMkdir;
let mockFsWriteFile;
let mockHttpServer;
let originalFetch;

beforeAll(async () => {
    mockBroadcastEvent = jest.fn();
    mockAutoLinkProviderConfigs = jest.fn().mockResolvedValue(undefined);
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);

    mockHttpServer = {
        listen: jest.fn(function (...args) {
            const cb = args.find(a => typeof a === 'function');
            if (cb) cb();
        }),
        close: jest.fn(function (cb) { if (cb) cb(); }),
        on: jest.fn(),
    };

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
        __esModule: true,
        broadcastEvent: mockBroadcastEvent,
    }));

    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        __esModule: true,
        autoLinkProviderConfigs: mockAutoLinkProviderConfigs,
    }));

    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        __esModule: true,
        CONFIG: {},
    }));

    await jest.unstable_mockModule('http', () => ({
        __esModule: true,
        default: {
            createServer: jest.fn().mockReturnValue(mockHttpServer),
        },
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        default: {
            promises: {
                mkdir: (...args) => mockFsMkdir(...args),
                writeFile: (...args) => mockFsWriteFile(...args),
            },
        },
        promises: {
            mkdir: (...args) => mockFsMkdir(...args),
            writeFile: (...args) => mockFsWriteFile(...args),
        },
    }));

    const mod = await import('../../../src/auth/gitlab-oauth.js');
    handleGitLabOAuth = mod.handleGitLabOAuth;
    refreshGitLabToken = mod.refreshGitLabToken;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockAutoLinkProviderConfigs.mockResolvedValue(undefined);
    originalFetch = global.fetch;
    global.fetch = jest.fn();
});

afterEach(() => {
    global.fetch = originalFetch;
});

// =============================================================================
// handleGitLabOAuth
// =============================================================================

describe('handleGitLabOAuth', () => {
    test('returns failure when clientId is missing', async () => {
        const result = await handleGitLabOAuth({});
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/client ID is required/i);
        expect(result.authInfo.provider).toBe('openai-gitlab-oauth');
    });

    test('returns failure when empty config', async () => {
        const result = await handleGitLabOAuth();
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/client ID/i);
    });

    test('returns authUrl when clientId provided', async () => {
        const result = await handleGitLabOAuth({
            GITLAB_OAUTH_CLIENT_ID: 'my-client-id',
            GITLAB_BASE_URL: 'https://gitlab.com',
        });

        expect(result.success).toBe(true);
        expect(result.authUrl).toBeDefined();
        expect(result.authUrl).toContain('gitlab.com/oauth/authorize');
        expect(result.authUrl).toContain('client_id=my-client-id');
        expect(result.authUrl).toContain('code_challenge_method=S256');
    });

    test('authInfo includes provider, method, baseUrl, callbackPort', async () => {
        const result = await handleGitLabOAuth({
            GITLAB_OAUTH_CLIENT_ID: 'cid',
        });
        expect(result.authInfo.provider).toBe('openai-gitlab-oauth');
        expect(result.authInfo.method).toBe('pkce');
        expect(result.authInfo.baseUrl).toBeDefined();
        expect(result.authInfo.callbackPort).toBeDefined();
    });

    test('uses custom callbackPort', async () => {
        const result = await handleGitLabOAuth({
            GITLAB_OAUTH_CLIENT_ID: 'cid',
            GITLAB_OAUTH_CALLBACK_PORT: 18080,
        });
        expect(result.authInfo.callbackPort).toBe(18080);
        expect(result.authUrl).toContain('18080');
    });

    test('normalizes baseUrl with trailing slash', async () => {
        const result = await handleGitLabOAuth({
            GITLAB_OAUTH_CLIENT_ID: 'cid',
            GITLAB_BASE_URL: 'https://gitlab.example.com/',
        });
        expect(result.authUrl).not.toContain('//oauth');
    });
});

// =============================================================================
// refreshGitLabToken
// =============================================================================

describe('refreshGitLabToken', () => {
    test('throws when refreshToken is empty', async () => {
        await expect(refreshGitLabToken('')).rejects.toThrow('No refresh token provided');
    });

    test('throws when refreshToken is null', async () => {
        await expect(refreshGitLabToken(null)).rejects.toThrow('No refresh token provided');
    });

    test('returns new token data on success', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
                token_type: 'bearer',
                scope: 'api read_user',
                created_at: Math.floor(Date.now() / 1000),
                expires_in: 7200,
            }),
        });

        const result = await refreshGitLabToken('old-refresh-token', {
            baseUrl: 'https://gitlab.com',
            clientId: 'client-id',
        });

        expect(result.access_token).toBe('new-access-token');
        expect(result.refresh_token).toBe('new-refresh-token');
    });

    test('includes client_id in request when provided', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt' }),
        });

        await refreshGitLabToken('rt', { clientId: 'my-client' });
        expect(global.fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ method: 'POST' })
        );
        const callArgs = global.fetch.mock.calls[0];
        expect(callArgs[1].body).toContain('client_id=my-client');
    });

    test('throws on non-ok HTTP response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        });

        await expect(refreshGitLabToken('rt', {})).rejects.toThrow('GitLab token refresh failed');
    });

    test('throws on invalid JSON response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => 'not-json',
        });

        await expect(refreshGitLabToken('rt', {})).rejects.toThrow('invalid JSON');
    });

    test('throws when access_token missing from response', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ token_type: 'bearer' }),
        });

        await expect(refreshGitLabToken('rt', {})).rejects.toThrow('no access_token');
    });

    test('uses default gitlab.com when baseUrl not provided', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ access_token: 'at' }),
        });

        await refreshGitLabToken('rt');
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('gitlab.com/oauth/token'),
            expect.any(Object)
        );
    });
});
