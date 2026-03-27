/**
 * Unit tests for src/ui-modules/oauth-api.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

const mockGetRequestBody = jest.fn();
jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    getRequestBody: mockGetRequestBody,
    MODEL_PROTOCOL_PREFIX: {},
}));

const mockHandleGeminiCliOAuth = jest.fn();
const mockHandleGeminiAntigravityOAuth = jest.fn();
const mockHandleQwenOAuth = jest.fn();
const mockHandleKiroOAuth = jest.fn();
const mockHandleIFlowOAuth = jest.fn();
const mockHandleCodexOAuth = jest.fn();
const mockHandleCursorOAuth = jest.fn();
const mockBatchImportGeminiTokensStream = jest.fn();
const mockBatchImportCodexTokensStream = jest.fn();
const mockBatchImportCursorTokensStream = jest.fn();
const mockBatchImportKiroRefreshTokensStream = jest.fn();
const mockImportAwsCredentials = jest.fn();

jest.unstable_mockModule('../../../src/auth/oauth-handlers.js', () => ({
    handleGeminiCliOAuth: mockHandleGeminiCliOAuth,
    handleGeminiAntigravityOAuth: mockHandleGeminiAntigravityOAuth,
    batchImportGeminiTokensStream: mockBatchImportGeminiTokensStream,
    handleQwenOAuth: mockHandleQwenOAuth,
    handleKiroOAuth: mockHandleKiroOAuth,
    handleIFlowOAuth: mockHandleIFlowOAuth,
    handleCodexOAuth: mockHandleCodexOAuth,
    batchImportCodexTokensStream: mockBatchImportCodexTokensStream,
    batchImportCursorTokensStream: mockBatchImportCursorTokensStream,
    batchImportKiroRefreshTokensStream: mockBatchImportKiroRefreshTokensStream,
    importAwsCredentials: mockImportAwsCredentials,
    handleCursorOAuth: mockHandleCursorOAuth,
    handleCodexOAuthCallback: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
let handleGenerateAuthUrl;
let handleManualOAuthCallback;
let handleBatchImportKiroTokens;
let handleBatchImportGeminiTokens;
let handleBatchImportCodexTokens;
let handleBatchImportCursorTokens;
let handleImportAwsCredentials;

function createMockRes() {
    return {
        writeHead: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        headersSent: false,
        writableEnded: false,
        destroyed: false,
    };
}

beforeAll(async () => {
    ({
        handleGenerateAuthUrl,
        handleManualOAuthCallback,
        handleBatchImportKiroTokens,
        handleBatchImportGeminiTokens,
        handleBatchImportCodexTokens,
        handleBatchImportCursorTokens,
        handleImportAwsCredentials,
    } = await import('../../../src/ui-modules/oauth-api.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleGenerateAuthUrl
// ---------------------------------------------------------------------------
describe('handleGenerateAuthUrl', () => {
    test('returns 400 for unsupported provider type', async () => {
        mockGetRequestBody.mockResolvedValue({});
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'unknown-provider');

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('Unsupported provider type');
    });

    test('generates auth URL for gemini-cli-oauth', async () => {
        mockGetRequestBody.mockResolvedValue({});
        mockHandleGeminiCliOAuth.mockResolvedValue({
            authUrl: 'https://accounts.google.com/auth',
            authInfo: { state: 'abc' },
        });
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'gemini-cli-oauth');

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.authUrl).toBe('https://accounts.google.com/auth');
    });

    test('generates auth URL for gemini-antigravity', async () => {
        mockGetRequestBody.mockResolvedValue({});
        mockHandleGeminiAntigravityOAuth.mockResolvedValue({
            authUrl: 'https://antigravity.example/auth',
            authInfo: {},
        });
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'gemini-antigravity');

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.authUrl).toBe('https://antigravity.example/auth');
    });

    test('generates auth URL for openai-qwen-oauth', async () => {
        mockGetRequestBody.mockResolvedValue({});
        mockHandleQwenOAuth.mockResolvedValue({
            authUrl: 'https://qwen.example/auth',
            authInfo: {},
        });
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'openai-qwen-oauth');

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.authUrl).toBe('https://qwen.example/auth');
    });

    test('generates auth URL for claude-kiro-oauth', async () => {
        mockGetRequestBody.mockResolvedValue({});
        mockHandleKiroOAuth.mockResolvedValue({
            authUrl: 'https://kiro.example/auth',
            authInfo: {},
        });
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'claude-kiro-oauth');

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    test('generates auth URL for openai-codex-oauth', async () => {
        mockGetRequestBody.mockResolvedValue({});
        mockHandleCodexOAuth.mockResolvedValue({
            authUrl: 'https://codex.example/auth',
            authInfo: {},
        });
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'openai-codex-oauth');

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    test('generates auth URL for cursor-oauth', async () => {
        mockGetRequestBody.mockResolvedValue({});
        mockHandleCursorOAuth.mockResolvedValue({
            authUrl: 'https://cursor.example/auth',
            authInfo: {},
        });
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'cursor-oauth');

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    test('returns 500 when OAuth handler throws', async () => {
        mockGetRequestBody.mockResolvedValue({});
        mockHandleGeminiCliOAuth.mockRejectedValue(new Error('OAuth failed'));
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'gemini-cli-oauth');

        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('Failed to generate auth URL');
    });

    test('proceeds with empty options when body parse fails', async () => {
        mockGetRequestBody.mockRejectedValue(new Error('no body'));
        mockHandleGeminiCliOAuth.mockResolvedValue({
            authUrl: 'https://accounts.google.com/auth',
            authInfo: {},
        });
        const req = {};
        const res = createMockRes();

        await handleGenerateAuthUrl(req, res, {}, 'gemini-cli-oauth');

        expect(mockHandleGeminiCliOAuth).toHaveBeenCalledWith({}, {});
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });
});

// ---------------------------------------------------------------------------
// handleManualOAuthCallback
// ---------------------------------------------------------------------------
describe('handleManualOAuthCallback', () => {
    test('returns 400 when provider is missing', async () => {
        mockGetRequestBody.mockResolvedValue({ callbackUrl: 'http://localhost/callback?code=abc' });
        const req = {};
        const res = createMockRes();

        await handleManualOAuthCallback(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });

    test('returns 400 when callbackUrl is missing', async () => {
        mockGetRequestBody.mockResolvedValue({ provider: 'gemini-cli-oauth' });
        const req = {};
        const res = createMockRes();

        await handleManualOAuthCallback(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 400 when callback URL has no code or token', async () => {
        mockGetRequestBody.mockResolvedValue({
            provider: 'gemini-cli-oauth',
            callbackUrl: 'http://localhost/callback',
        });
        const req = {};
        const res = createMockRes();

        await handleManualOAuthCallback(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error).toContain('code or token');
    });

    test('returns 500 when unexpected error occurs', async () => {
        mockGetRequestBody.mockRejectedValue(new Error('parse error'));
        const req = {};
        const res = createMockRes();

        await handleManualOAuthCallback(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});

// ---------------------------------------------------------------------------
// handleBatchImportKiroTokens
// ---------------------------------------------------------------------------
describe('handleBatchImportKiroTokens', () => {
    test('returns 400 when refreshTokens is missing', async () => {
        mockGetRequestBody.mockResolvedValue({});
        const req = {};
        const res = createMockRes();

        await handleBatchImportKiroTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });

    test('returns 400 when refreshTokens is empty array', async () => {
        mockGetRequestBody.mockResolvedValue({ refreshTokens: [] });
        const req = {};
        const res = createMockRes();

        await handleBatchImportKiroTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 400 when refreshTokens is not an array', async () => {
        mockGetRequestBody.mockResolvedValue({ refreshTokens: 'not-array' });
        const req = {};
        const res = createMockRes();

        await handleBatchImportKiroTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('sends SSE events for successful batch import', async () => {
        mockGetRequestBody.mockResolvedValue({ refreshTokens: ['token1', 'token2'] });
        mockBatchImportKiroRefreshTokensStream.mockResolvedValue({
            total: 2,
            success: 2,
            failed: 0,
            details: [],
        });
        const req = {};
        const res = createMockRes();

        await handleBatchImportKiroTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream',
        }));
        expect(res.write).toHaveBeenCalled();
        expect(res.end).toHaveBeenCalled();
    });

    test('uses default region when not provided', async () => {
        mockGetRequestBody.mockResolvedValue({ refreshTokens: ['token1'] });
        mockBatchImportKiroRefreshTokensStream.mockResolvedValue({
            total: 1, success: 1, failed: 0, details: [],
        });
        const req = {};
        const res = createMockRes();

        await handleBatchImportKiroTokens(req, res);

        expect(mockBatchImportKiroRefreshTokensStream).toHaveBeenCalledWith(
            ['token1'],
            'us-east-1',
            expect.any(Function)
        );
    });
});

// ---------------------------------------------------------------------------
// handleBatchImportGeminiTokens
// ---------------------------------------------------------------------------
describe('handleBatchImportGeminiTokens', () => {
    test('returns 400 when providerType is missing', async () => {
        mockGetRequestBody.mockResolvedValue({ tokens: ['tok1'] });
        const req = {};
        const res = createMockRes();

        await handleBatchImportGeminiTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 400 when tokens array is empty', async () => {
        mockGetRequestBody.mockResolvedValue({ providerType: 'gemini-cli-oauth', tokens: [] });
        const req = {};
        const res = createMockRes();

        await handleBatchImportGeminiTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('sends SSE events for successful batch import', async () => {
        mockGetRequestBody.mockResolvedValue({
            providerType: 'gemini-cli-oauth',
            tokens: [{ access_token: 'abc' }],
        });
        mockBatchImportGeminiTokensStream.mockResolvedValue({
            total: 1, success: 1, failed: 0, details: [],
        });
        const req = {};
        const res = createMockRes();

        await handleBatchImportGeminiTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream',
        }));
        expect(res.end).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// handleBatchImportCodexTokens
// ---------------------------------------------------------------------------
describe('handleBatchImportCodexTokens', () => {
    test('returns 400 when tokens is missing', async () => {
        mockGetRequestBody.mockResolvedValue({});
        const req = {};
        const res = createMockRes();

        await handleBatchImportCodexTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });

    test('returns 400 when tokens array is empty', async () => {
        mockGetRequestBody.mockResolvedValue({ tokens: [] });
        const req = {};
        const res = createMockRes();

        await handleBatchImportCodexTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('sends SSE events for successful batch import', async () => {
        mockGetRequestBody.mockResolvedValue({ tokens: [{ token: 'abc123' }] });
        mockBatchImportCodexTokensStream.mockResolvedValue({
            total: 1, success: 1, failed: 0, details: [],
        });
        const req = {};
        const res = createMockRes();

        await handleBatchImportCodexTokens(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream',
        }));
        expect(res.end).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// handleImportAwsCredentials
// ---------------------------------------------------------------------------
describe('handleImportAwsCredentials', () => {
    test('returns 400 when credentials is missing', async () => {
        mockGetRequestBody.mockResolvedValue({});
        const req = {};
        const res = createMockRes();

        await handleImportAwsCredentials(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });

    test('returns 400 when credentials is empty array', async () => {
        mockGetRequestBody.mockResolvedValue({ credentials: [] });
        const req = {};
        const res = createMockRes();

        await handleImportAwsCredentials(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 400 when single credential is missing required fields', async () => {
        mockGetRequestBody.mockResolvedValue({
            credentials: { clientId: 'id' }, // missing clientSecret, accessToken, refreshToken
        });
        const req = {};
        const res = createMockRes();

        await handleImportAwsCredentials(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error).toContain('Missing required fields');
    });

    test('returns 400 when credentials is invalid type (string)', async () => {
        mockGetRequestBody.mockResolvedValue({ credentials: 'invalid' });
        const req = {};
        const res = createMockRes();

        await handleImportAwsCredentials(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('imports single credential successfully', async () => {
        mockGetRequestBody.mockResolvedValue({
            credentials: {
                clientId: 'id',
                clientSecret: 'secret',
                accessToken: 'access',
                refreshToken: 'refresh',
            },
        });
        mockImportAwsCredentials.mockResolvedValue({
            success: true,
            path: 'configs/kiro/test.json',
        });
        const req = {};
        const res = createMockRes();

        await handleImportAwsCredentials(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
    });

    test('returns 409 for duplicate credential', async () => {
        mockGetRequestBody.mockResolvedValue({
            credentials: {
                clientId: 'id',
                clientSecret: 'secret',
                accessToken: 'access',
                refreshToken: 'refresh',
            },
        });
        mockImportAwsCredentials.mockResolvedValue({
            success: false,
            error: 'duplicate',
            existingPath: 'configs/kiro/existing.json',
        });
        const req = {};
        const res = createMockRes();

        await handleImportAwsCredentials(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });

    test('returns 400 when batch credentials have validation errors', async () => {
        mockGetRequestBody.mockResolvedValue({
            credentials: [
                { clientId: 'id' }, // missing fields
            ],
        });
        const req = {};
        const res = createMockRes();

        await handleImportAwsCredentials(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.validationErrors).toBeDefined();
    });

    test('sends SSE for batch credential import', async () => {
        mockGetRequestBody.mockResolvedValue({
            credentials: [
                {
                    clientId: 'id1',
                    clientSecret: 'secret1',
                    accessToken: 'access1',
                    refreshToken: 'refresh1',
                },
            ],
        });
        mockImportAwsCredentials.mockResolvedValue({
            success: true,
            path: 'configs/kiro/test.json',
        });
        const req = {};
        const res = createMockRes();

        await handleImportAwsCredentials(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream',
        }));
        expect(res.end).toHaveBeenCalled();
    });
});
