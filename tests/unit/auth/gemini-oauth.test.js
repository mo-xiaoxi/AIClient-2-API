/**
 * Unit tests for gemini-oauth.js
 *
 * Tests: handleGeminiCliOAuth, handleGeminiAntigravityOAuth,
 *        checkGeminiCredentialsDuplicate, batchImportGeminiTokensStream
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let handleGeminiCliOAuth;
let handleGeminiAntigravityOAuth;
let checkGeminiCredentialsDuplicate;
let batchImportGeminiTokensStream;

// Mock state for fs
let mockFsExistsSync;
let mockFsReaddir;
let mockFsReadFile;
let mockFsMkdir;
let mockFsWriteFile;
let mockBroadcastEvent;
let mockAutoLinkProviderConfigs;
let mockOAuth2Client;
let mockHttpServer;

beforeAll(async () => {
    mockBroadcastEvent = jest.fn();
    mockAutoLinkProviderConfigs = jest.fn().mockResolvedValue(undefined);

    // Create a mock HTTP server that "listens" immediately
    mockHttpServer = {
        listen: jest.fn(function (port, host, cb) { if (cb) cb(); }),
        close: jest.fn(function (cb) { if (cb) cb(); }),
        on: jest.fn(),
        listening: true,
    };

    mockOAuth2Client = {
        redirectUri: null,
        generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock'),
        getToken: jest.fn().mockResolvedValue({ tokens: { access_token: 'at', refresh_token: 'rt' } }),
    };

    mockFsExistsSync = jest.fn().mockReturnValue(false);
    mockFsReaddir = jest.fn().mockResolvedValue([]);
    mockFsReadFile = jest.fn().mockResolvedValue('{}');
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);

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
        getGoogleAuthProxyConfig: jest.fn().mockReturnValue(null),
    }));

    await jest.unstable_mockModule('google-auth-library', () => ({
        __esModule: true,
        OAuth2Client: jest.fn().mockImplementation(() => mockOAuth2Client),
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

    const mod = await import('../../../src/auth/gemini-oauth.js');
    handleGeminiCliOAuth = mod.handleGeminiCliOAuth;
    handleGeminiAntigravityOAuth = mod.handleGeminiAntigravityOAuth;
    checkGeminiCredentialsDuplicate = mod.checkGeminiCredentialsDuplicate;
    batchImportGeminiTokensStream = mod.batchImportGeminiTokensStream;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockFsExistsSync.mockReturnValue(false);
    mockFsReaddir.mockResolvedValue([]);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockAutoLinkProviderConfigs.mockResolvedValue(undefined);
    mockBroadcastEvent.mockClear();
    mockHttpServer.listen.mockImplementation(function (port, host, cb) { if (cb) cb(); });
    mockHttpServer.on.mockImplementation(function () {});
});

// =============================================================================
// handleGeminiCliOAuth
// =============================================================================

describe('handleGeminiCliOAuth', () => {
    test('returns authUrl and authInfo on success', async () => {
        const result = await handleGeminiCliOAuth({});
        expect(result.authUrl).toBeDefined();
        expect(typeof result.authUrl).toBe('string');
        expect(result.authInfo).toBeDefined();
        expect(result.authInfo.provider).toBe('gemini-cli-oauth');
    });

    test('authUrl contains accounts.google.com', async () => {
        const result = await handleGeminiCliOAuth({});
        expect(result.authUrl).toContain('accounts.google.com');
    });

    test('authInfo contains redirectUri and port', async () => {
        const result = await handleGeminiCliOAuth({});
        expect(result.authInfo.redirectUri).toBeDefined();
        expect(result.authInfo.port).toBeDefined();
    });

    test('accepts options.port to override default', async () => {
        const result = await handleGeminiCliOAuth({}, { port: 9999 });
        expect(result.authInfo.port).toBe(9999);
    });

    test('passes options.saveToConfigs through to authInfo', async () => {
        const result = await handleGeminiCliOAuth({}, { saveToConfigs: true, providerDir: 'gemini' });
        expect(result.authInfo.saveToConfigs).toBe(true);
    });
});

// =============================================================================
// handleGeminiAntigravityOAuth
// =============================================================================

describe('handleGeminiAntigravityOAuth', () => {
    test('returns authUrl and authInfo', async () => {
        const result = await handleGeminiAntigravityOAuth({});
        expect(result.authUrl).toBeDefined();
        expect(result.authInfo.provider).toBe('gemini-antigravity');
    });

    test('uses different port than gemini-cli-oauth', async () => {
        const cliResult = await handleGeminiCliOAuth({});
        const agResult = await handleGeminiAntigravityOAuth({});
        // Both should return valid results with different default ports
        expect(cliResult.authInfo.port).not.toBe(agResult.authInfo.port);
    });

    test('authInfo contains provider information', async () => {
        const result = await handleGeminiAntigravityOAuth({});
        expect(result.authInfo.provider).toBe('gemini-antigravity');
        expect(result.authInfo.redirectUri).toContain('localhost');
    });
});

// =============================================================================
// checkGeminiCredentialsDuplicate
// =============================================================================

describe('checkGeminiCredentialsDuplicate', () => {
    test('returns isDuplicate: false when directory does not exist', async () => {
        mockFsExistsSync.mockReturnValue(false);
        const result = await checkGeminiCredentialsDuplicate('gemini-cli-oauth', 'test-rt');
        expect(result.isDuplicate).toBe(false);
    });

    test('returns isDuplicate: false when no files match', async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsReaddir.mockResolvedValue(['file1.json']);
        mockFsReadFile.mockResolvedValue(JSON.stringify({ refresh_token: 'different-rt' }));
        const result = await checkGeminiCredentialsDuplicate('gemini-cli-oauth', 'test-rt');
        expect(result.isDuplicate).toBe(false);
    });

    test('returns isDuplicate: true when refresh_token matches', async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsReaddir.mockResolvedValue(['existing.json']);
        mockFsReadFile.mockResolvedValue(JSON.stringify({ refresh_token: 'matching-rt' }));
        const result = await checkGeminiCredentialsDuplicate('gemini-cli-oauth', 'matching-rt');
        expect(result.isDuplicate).toBe(true);
        expect(result.existingPath).toBeDefined();
    });

    test('returns isDuplicate: false for unknown providerType', async () => {
        const result = await checkGeminiCredentialsDuplicate('unknown-provider', 'rt');
        expect(result.isDuplicate).toBe(false);
    });

    test('handles JSON parse errors gracefully', async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsReaddir.mockResolvedValue(['bad.json']);
        mockFsReadFile.mockResolvedValue('not-valid-json{{{');
        const result = await checkGeminiCredentialsDuplicate('gemini-cli-oauth', 'rt');
        expect(result.isDuplicate).toBe(false);
    });

    test('skips non-.json files', async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsReaddir.mockResolvedValue(['readme.txt', 'notes.md']);
        const result = await checkGeminiCredentialsDuplicate('gemini-cli-oauth', 'rt');
        expect(mockFsReadFile).not.toHaveBeenCalled();
        expect(result.isDuplicate).toBe(false);
    });
});

// =============================================================================
// batchImportGeminiTokensStream
// =============================================================================

describe('batchImportGeminiTokensStream', () => {
    test('returns results with total, success, failed counts', async () => {
        const tokens = [
            { access_token: 'at1', refresh_token: 'rt1' },
            { access_token: 'at2', refresh_token: 'rt2' },
        ];
        const result = await batchImportGeminiTokensStream('gemini-cli-oauth', tokens, null, true);
        expect(result.total).toBe(2);
        expect(result.success).toBe(2);
        expect(result.failed).toBe(0);
    });

    test('marks token as failed when missing required fields', async () => {
        const tokens = [{ access_token: 'at' }]; // missing refresh_token
        const result = await batchImportGeminiTokensStream('gemini-cli-oauth', tokens, null, true);
        expect(result.failed).toBe(1);
        expect(result.success).toBe(0);
    });

    test('throws for unknown provider', async () => {
        await expect(
            batchImportGeminiTokensStream('unknown-provider', [])
        ).rejects.toThrow('未知的提供商');
    });

    test('calls onProgress callback for each token', async () => {
        const tokens = [
            { access_token: 'at1', refresh_token: 'rt1' },
        ];
        const onProgress = jest.fn();
        await batchImportGeminiTokensStream('gemini-cli-oauth', tokens, onProgress, true);
        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
            index: 1,
            total: 1,
        }));
    });

    test('broadcasts oauth_batch_success event when tokens imported successfully', async () => {
        const tokens = [{ access_token: 'at1', refresh_token: 'rt1' }];
        await batchImportGeminiTokensStream('gemini-cli-oauth', tokens, null, true);
        expect(mockBroadcastEvent).toHaveBeenCalledWith('oauth_batch_success', expect.objectContaining({
            provider: 'gemini-cli-oauth',
            count: 1,
        }));
    });

    test('marks duplicate tokens as failed when duplicate check is enabled', async () => {
        mockFsExistsSync.mockReturnValue(true);
        mockFsReaddir.mockResolvedValue(['existing.json']);
        mockFsReadFile.mockResolvedValue(JSON.stringify({ refresh_token: 'dup-rt' }));

        const tokens = [{ access_token: 'at', refresh_token: 'dup-rt' }];
        const result = await batchImportGeminiTokensStream('gemini-cli-oauth', tokens, null, false);
        expect(result.failed).toBe(1);
        expect(result.details[0].error).toBe('duplicate');
    });
});
