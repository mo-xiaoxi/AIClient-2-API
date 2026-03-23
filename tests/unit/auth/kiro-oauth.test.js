/**
 * Unit tests for kiro-oauth.js
 *
 * Tests: handleKiroOAuth (google/github/builder-id methods),
 *        checkKiroCredentialsDuplicate, batchImportKiroRefreshTokensStream
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let handleKiroOAuth;
let checkKiroCredentialsDuplicate;
let batchImportKiroRefreshTokensStream;
let batchImportKiroRefreshTokens;

let mockBroadcastEvent;
let mockAutoLinkProviderConfigs;
let mockFsExistsSync;
let mockFsReaddir;
let mockFsReadFile;
let mockFsMkdir;
let mockFsWriteFile;
let mockHttpServer;

beforeAll(async () => {
    mockBroadcastEvent = jest.fn();
    mockAutoLinkProviderConfigs = jest.fn().mockResolvedValue(undefined);
    mockFsExistsSync = jest.fn().mockReturnValue(false);
    mockFsReaddir = jest.fn().mockResolvedValue([]);
    mockFsReadFile = jest.fn().mockResolvedValue('{}');
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);

    mockHttpServer = {
        listen: jest.fn(function (port, host, cb) { if (cb) cb(); }),
        close: jest.fn(function (cb) { if (cb) cb(); }),
        on: jest.fn(),
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

    await jest.unstable_mockModule('axios', () => {
        const mockFn = jest.fn().mockResolvedValue({
            status: 200,
            statusText: 'OK',
            data: { access_token: 'at', refresh_token: 'rt' },
            headers: {},
        });
        mockFn.create = jest.fn().mockReturnValue(mockFn);
        return { __esModule: true, default: mockFn };
    });

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
                readdir: (...args) => mockFsReaddir(...args),
                readFile: (...args) => mockFsReadFile(...args),
                mkdir: (...args) => mockFsMkdir(...args),
                writeFile: (...args) => mockFsWriteFile(...args),
            },
        },
        existsSync: (...args) => mockFsExistsSync(...args),
        promises: {
            readdir: (...args) => mockFsReaddir(...args),
            readFile: (...args) => mockFsReadFile(...args),
            mkdir: (...args) => mockFsMkdir(...args),
            writeFile: (...args) => mockFsWriteFile(...args),
        },
    }));

    // Mock axios for refreshKiroToken calls inside batchImportKiroRefreshTokensStream
    await jest.unstable_mockModule('axios', () => {
        const mockFn = jest.fn().mockResolvedValue({
            status: 200,
            statusText: 'OK',
            data: {
                refreshToken: 'new-rt',
                accessToken: 'new-at',
                expiresAt: Date.now() + 3600000,
            },
            headers: {},
        });
        mockFn.create = jest.fn().mockReturnValue(mockFn);
        return { __esModule: true, default: mockFn };
    });

    const mod = await import('../../../src/auth/kiro-oauth.js');
    handleKiroOAuth = mod.handleKiroOAuth;
    checkKiroCredentialsDuplicate = mod.checkKiroCredentialsDuplicate;
    batchImportKiroRefreshTokensStream = mod.batchImportKiroRefreshTokensStream;
    batchImportKiroRefreshTokens = mod.batchImportKiroRefreshTokens;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockFsExistsSync.mockReturnValue(false);
    mockFsReaddir.mockResolvedValue([]);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockAutoLinkProviderConfigs.mockResolvedValue(undefined);
    mockHttpServer.listen.mockImplementation(function (port, host, cb) { if (cb) cb(); });
    mockHttpServer.on.mockImplementation(function () {});
});

// =============================================================================
// handleKiroOAuth — routing to correct auth method
// =============================================================================

describe('handleKiroOAuth', () => {
    test('defaults to google method and returns authUrl', async () => {
        const result = await handleKiroOAuth({}, { method: 'google', port: 19876 });
        expect(result.authUrl).toBeDefined();
        expect(typeof result.authUrl).toBe('string');
    });

    test('returns authUrl for github method', async () => {
        const result = await handleKiroOAuth({}, { method: 'github', port: 19877 });
        expect(result.authUrl).toBeDefined();
    });

    test('authInfo contains provider claude-kiro-oauth for google method', async () => {
        const result = await handleKiroOAuth({}, { method: 'google', port: 19876 });
        expect(result.authInfo).toBeDefined();
        expect(result.authInfo.provider).toBe('claude-kiro-oauth');
    });

    test('throws for unsupported method', async () => {
        await expect(handleKiroOAuth({}, { method: 'unsupported-sso' }))
            .rejects.toThrow();
    });

    test('authUrl contains kiro.dev for social auth', async () => {
        const result = await handleKiroOAuth({}, { method: 'google', port: 19878 });
        expect(result.authUrl).toContain('kiro.dev');
    });

    test('authUrl contains code_challenge for PKCE', async () => {
        const result = await handleKiroOAuth({}, { method: 'google', port: 19879 });
        expect(result.authUrl).toContain('code_challenge');
    });
});

// Helper to create dirent-like objects for readdir withFileTypes
function makeDirent(name, isFile = true, isDir = false) {
    return { name, isFile: () => isFile, isDirectory: () => isDir };
}

// =============================================================================
// checkKiroCredentialsDuplicate
// =============================================================================

describe('checkKiroCredentialsDuplicate', () => {
    test('returns isDuplicate: false when directory does not exist', async () => {
        mockFsExistsSync.mockReturnValue(false);
        const result = await checkKiroCredentialsDuplicate('test-rt');
        expect(result.isDuplicate).toBe(false);
    });

    test('returns isDuplicate: false when no files match', async () => {
        mockFsExistsSync.mockReturnValue(true);
        // readdir returns dirent objects with isFile/isDirectory methods
        mockFsReaddir.mockResolvedValue([makeDirent('file1.json')]);
        mockFsReadFile.mockResolvedValue(JSON.stringify({ refreshToken: 'different-rt' }));
        const result = await checkKiroCredentialsDuplicate('test-rt');
        expect(result.isDuplicate).toBe(false);
    });

    test('returns isDuplicate: true when refreshToken (camelCase) matches', async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsReaddir.mockResolvedValue([makeDirent('match.json')]);
        mockFsReadFile.mockResolvedValue(JSON.stringify({ refreshToken: 'match-rt' }));
        const result = await checkKiroCredentialsDuplicate('match-rt');
        expect(result.isDuplicate).toBe(true);
        expect(result.existingPath).toBeDefined();
    });

    test('handles malformed JSON gracefully', async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsReaddir.mockResolvedValue([makeDirent('bad.json')]);
        mockFsReadFile.mockResolvedValue('not-valid-json!');
        const result = await checkKiroCredentialsDuplicate('rt');
        expect(result.isDuplicate).toBe(false);
    });

    test('skips non-.json files', async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsReaddir.mockResolvedValue([makeDirent('readme.txt')]);
        const result = await checkKiroCredentialsDuplicate('rt');
        expect(mockFsReadFile).not.toHaveBeenCalled();
        expect(result.isDuplicate).toBe(false);
    });
});

// =============================================================================
// batchImportKiroRefreshTokensStream
// (takes an array of raw refresh token strings, not objects)
// =============================================================================

describe('batchImportKiroRefreshTokensStream', () => {
    test('returns empty results for empty token list', async () => {
        const result = await batchImportKiroRefreshTokensStream([], 'us-east-1', null, true);
        expect(result.total).toBe(0);
        expect(result.success).toBe(0);
        expect(result.failed).toBe(0);
    });

    test('marks token as failed for empty string', async () => {
        const tokens = [''];
        const result = await batchImportKiroRefreshTokensStream(tokens, 'us-east-1', null, true);
        expect(result.failed).toBe(1);
        expect(result.success).toBe(0);
    });

    test('calls onProgress for each token', async () => {
        const tokens = ['valid-rt-1', 'valid-rt-2'];
        const onProgress = jest.fn();
        await batchImportKiroRefreshTokensStream(tokens, 'us-east-1', onProgress, true);
        expect(onProgress).toHaveBeenCalledTimes(2);
    });

    test('details length matches input token count', async () => {
        const tokens = ['', '', ''];
        const result = await batchImportKiroRefreshTokensStream(tokens, 'us-east-1', null, true);
        expect(result.total).toBe(3);
        expect(result.details).toHaveLength(3);
    });

    test('processes valid refresh tokens successfully', async () => {
        const tokens = ['valid-refresh-token'];
        const result = await batchImportKiroRefreshTokensStream(tokens, 'us-east-1', null, true);
        expect(result.total).toBe(1);
        expect(result.success).toBe(1);
    });
});
