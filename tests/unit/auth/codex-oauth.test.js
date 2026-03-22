/**
 * Unit tests for codex-oauth.js
 *
 * Tests: handleCodexOAuth, handleCodexOAuthCallback, batchImportCodexTokensStream
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let handleCodexOAuth;
let handleCodexOAuthCallback;
let batchImportCodexTokensStream;

let mockBroadcastEvent;
let mockAutoLinkProviderConfigs;
let mockAxiosInstance;
let mockHttpServer;
let mockFsMkdir;
let mockFsWriteFile;
let mockFsExistsSync;
let mockFsReaddir;
let mockFsReadFile;
let mockOpen;

/**
 * Build a fake JWT with the given payload object.
 */
function makeFakeJWT(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.fakesignature`;
}

beforeAll(async () => {
    mockBroadcastEvent = jest.fn();
    mockAutoLinkProviderConfigs = jest.fn().mockResolvedValue(undefined);
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);
    mockFsExistsSync = jest.fn().mockReturnValue(false);
    mockFsReaddir = jest.fn().mockResolvedValue([]);
    mockFsReadFile = jest.fn().mockResolvedValue('{}');
    mockOpen = jest.fn().mockResolvedValue(undefined);

    mockAxiosInstance = jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {},
        headers: {},
    });

    mockHttpServer = {
        listen: jest.fn(function (...args) {
            // Handle both (port, cb) and (port, host, cb) signatures
            const cb = args.find(a => typeof a === 'function');
            if (cb) cb();
        }),
        close: jest.fn(function (cb) { if (cb) cb(); }),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
        listening: true,
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

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        getProxyConfigForProvider: jest.fn().mockReturnValue(null),
    }));

    await jest.unstable_mockModule('axios', () => ({
        __esModule: true,
        default: Object.assign(mockAxiosInstance, {
            create: jest.fn().mockReturnValue(mockAxiosInstance),
        }),
    }));

    await jest.unstable_mockModule('open', () => ({
        __esModule: true,
        default: mockOpen,
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
            existsSync: (...args) => mockFsExistsSync(...args),
            promises: {
                mkdir: (...args) => mockFsMkdir(...args),
                writeFile: (...args) => mockFsWriteFile(...args),
                readdir: (...args) => mockFsReaddir(...args),
                readFile: (...args) => mockFsReadFile(...args),
            },
        },
        existsSync: (...args) => mockFsExistsSync(...args),
        promises: {
            mkdir: (...args) => mockFsMkdir(...args),
            writeFile: (...args) => mockFsWriteFile(...args),
            readdir: (...args) => mockFsReaddir(...args),
            readFile: (...args) => mockFsReadFile(...args),
        },
    }));

    const mod = await import('../../../src/auth/codex-oauth.js');
    handleCodexOAuth = mod.handleCodexOAuth;
    handleCodexOAuthCallback = mod.handleCodexOAuthCallback;
    batchImportCodexTokensStream = mod.batchImportCodexTokensStream;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsExistsSync.mockReturnValue(false);
    mockFsReaddir.mockResolvedValue([]);
    mockAutoLinkProviderConfigs.mockResolvedValue(undefined);
    mockHttpServer.listen.mockImplementation(function (...args) {
        const cb = args.find(a => typeof a === 'function');
        if (cb) cb();
    });
    mockHttpServer.on.mockImplementation(function () {});
    mockHttpServer.once.mockImplementation(function () {});
    mockHttpServer.emit.mockImplementation(function () {});
    mockAxiosInstance.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {},
        headers: {},
    });
    // Reset global codex sessions
    if (global.codexOAuthSessions) {
        global.codexOAuthSessions.clear();
    }
});

// =============================================================================
// handleCodexOAuth
// =============================================================================

describe('handleCodexOAuth', () => {
    test('returns object with authUrl field', async () => {
        const result = await handleCodexOAuth({});
        expect(result.authUrl).toBeDefined();
        expect(typeof result.authUrl).toBe('string');
    });

    test('authUrl contains auth.openai.com', async () => {
        const result = await handleCodexOAuth({});
        expect(result.authUrl).toContain('auth.openai.com');
    });

    test('authUrl contains PKCE code_challenge parameter', async () => {
        const result = await handleCodexOAuth({});
        const url = new URL(result.authUrl);
        expect(url.searchParams.get('code_challenge')).toBeTruthy();
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    test('authUrl contains required OAuth parameters', async () => {
        const result = await handleCodexOAuth({});
        const url = new URL(result.authUrl);
        expect(url.searchParams.get('client_id')).toBeTruthy();
        expect(url.searchParams.get('response_type')).toBe('code');
    });

    test('authInfo contains provider openai-codex-oauth', async () => {
        const result = await handleCodexOAuth({});
        expect(result.authInfo.provider).toBe('openai-codex-oauth');
    });

    test('result has success field', async () => {
        const result = await handleCodexOAuth({});
        // Whether success or not, the field should be present as boolean
        expect(typeof result.success).toBe('boolean');
    });
});

// =============================================================================
// handleCodexOAuthCallback
// =============================================================================

describe('handleCodexOAuthCallback', () => {
    test('returns failure when no pending OAuth session exists', async () => {
        // Ensure no session is registered
        if (global.codexOAuthSessions) global.codexOAuthSessions.clear();
        const result = await handleCodexOAuthCallback('some-code', 'nonexistent-state');
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
    });

    test('broadcasts oauth_error when session does not exist', async () => {
        if (global.codexOAuthSessions) global.codexOAuthSessions.clear();
        await handleCodexOAuthCallback('code', 'bad-state');
        expect(mockBroadcastEvent).toHaveBeenCalledWith('oauth_error', expect.objectContaining({
            provider: 'openai-codex-oauth',
        }));
    });
});

// =============================================================================
// batchImportCodexTokensStream
// =============================================================================

describe('batchImportCodexTokensStream', () => {
    test('returns correct summary for empty token array', async () => {
        const result = await batchImportCodexTokensStream([], null, true);
        expect(result.total).toBe(0);
        expect(result.success).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.details).toHaveLength(0);
    });

    test('marks token as failed when access_token or id_token is missing', async () => {
        const tokens = [{ access_token: 'at1' }]; // missing id_token
        const result = await batchImportCodexTokensStream(tokens, null, true);
        expect(result.failed).toBe(1);
        expect(result.success).toBe(0);
    });

    test('details array length equals tokens length', async () => {
        const tokens = [
            { access_token: 'at1' }, // invalid — missing id_token
            { access_token: 'at2' }, // invalid — missing id_token
        ];
        const result = await batchImportCodexTokensStream(tokens, null, true);
        expect(result.details).toHaveLength(2);
        expect(result.total).toBe(2);
    });

    test('calls onProgress callback for each token', async () => {
        const tokens = [
            { access_token: 'at1' },
            { access_token: 'at2' },
        ];
        const onProgress = jest.fn();
        await batchImportCodexTokensStream(tokens, onProgress, true);
        expect(onProgress).toHaveBeenCalledTimes(2);
    });

    test('processes valid JWT tokens successfully', async () => {
        const fakeJWT = makeFakeJWT({ sub: 'user-123', email: 'user@example.com' });
        const tokens = [
            { access_token: 'at1', id_token: fakeJWT, refresh_token: 'rt1' },
        ];
        const result = await batchImportCodexTokensStream(tokens, null, true);
        expect(result.success).toBe(1);
        expect(result.failed).toBe(0);
    });

    test('broadcasts oauth_batch_success when at least one token is imported', async () => {
        const fakeJWT = makeFakeJWT({ sub: 'user-123', email: 'user@example.com' });
        const tokens = [
            { access_token: 'at1', id_token: fakeJWT, refresh_token: 'rt1' },
        ];
        await batchImportCodexTokensStream(tokens, null, true);
        expect(mockBroadcastEvent).toHaveBeenCalledWith('oauth_batch_success', expect.objectContaining({
            provider: 'openai-codex-oauth',
        }));
    });
});
