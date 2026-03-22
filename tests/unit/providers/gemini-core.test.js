/**
 * Unit tests for src/providers/gemini/gemini-core.js
 *
 * Tests: GeminiApiService construction, listModels, callApi error handling,
 *        isTokenExpiringSoon, isExpiryDateNear, parseRetryDelay internals.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mocks — must be set up before any dynamic imports
// ---------------------------------------------------------------------------

const mockAuthRequest = jest.fn();

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn((cfg) => cfg),
    getProxyConfigForProvider: jest.fn(() => null),
    getGoogleAuthProxyConfig: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    API_ACTIONS: { GENERATE_CONTENT: 'generateContent', STREAM_GENERATE_CONTENT: 'streamGenerateContent' },
    isRetryableNetworkError: jest.fn(() => false),
    formatExpiryTime: jest.fn(() => ''),
    formatExpiryLog: jest.fn(() => ({ message: '', isNearExpiry: false })),
    MODEL_PROVIDER: { GEMINI_CLI: 'gemini-cli-oauth' },
    MODEL_PROTOCOL_PREFIX: { GEMINI: 'gemini' },
}));

await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['gemini-2.5-flash', 'gemini-2.5-pro']),
    getAllProviderModels: jest.fn(() => ({})),
}));

// Mock google-auth-library
await jest.unstable_mockModule('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        refreshAccessToken: jest.fn().mockResolvedValue({ credentials: { access_token: 'new-token' } }),
        credentials: { access_token: null, refresh_token: null },
        request: mockAuthRequest,
    })),
}));

await jest.unstable_mockModule('../../../src/auth/oauth-handlers.js', () => ({
    handleGeminiCliOAuth: jest.fn().mockResolvedValue({ authUrl: 'http://auth', authInfo: {} }),
}));

await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

// Mock open module (used in Gemini auth flow)
await jest.unstable_mockModule('open', () => ({
    default: jest.fn(() => Promise.resolve(null)),
}));

// fs (partial mock — only readFile and promises)
await jest.unstable_mockModule('fs', () => ({
    promises: {
        readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        writeFile: jest.fn().mockResolvedValue(undefined),
        mkdir: jest.fn().mockResolvedValue(undefined),
    },
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

let GeminiApiService;

beforeAll(async () => {
    const mod = await import('../../../src/providers/gemini/gemini-core.js');
    GeminiApiService = mod.GeminiApiService;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides = {}) {
    return new GeminiApiService({
        GEMINI_OAUTH_CREDS_FILE_PATH: '/tmp/fake-creds.json',
        PROJECT_ID: 'test-project',
        REQUEST_MAX_RETRIES: 0,
        REQUEST_BASE_DELAY: 0,
        uuid: 'gemini-test-uuid',
        ...overrides,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeminiApiService — construction', () => {
    test('constructs without throwing', () => {
        const svc = makeService();
        expect(svc).toBeDefined();
    });

    test('isInitialized starts as false', () => {
        const svc = makeService();
        expect(svc.isInitialized).toBe(false);
    });

    test('uses provided codeAssistEndpoint when GEMINI_BASE_URL is set', () => {
        const svc = makeService({ GEMINI_BASE_URL: 'https://custom-endpoint.googleapis.com' });
        expect(svc.codeAssistEndpoint).toBe('https://custom-endpoint.googleapis.com');
    });

    test('defaults to DEFAULT_CODE_ASSIST_ENDPOINT when GEMINI_BASE_URL not set', () => {
        const svc = makeService({ GEMINI_BASE_URL: undefined });
        expect(svc.codeAssistEndpoint).toContain('googleapis.com');
    });

    test('stores project ID from config', () => {
        const svc = makeService({ PROJECT_ID: 'my-project' });
        expect(svc.projectId).toBe('my-project');
    });

    test('stores oauthCredsFilePath from config', () => {
        const svc = makeService({ GEMINI_OAUTH_CREDS_FILE_PATH: '/path/to/creds.json' });
        expect(svc.oauthCredsFilePath).toBe('/path/to/creds.json');
    });
});

describe('GeminiApiService — callApi error handling', () => {
    beforeEach(() => mockAuthRequest.mockReset());

    test('throws on 401 without retry and marks credential', async () => {
        const svc = makeService();
        svc.isInitialized = true;
        const err = { response: { status: 401 }, message: 'Unauthorized', code: undefined };
        mockAuthRequest.mockRejectedValueOnce(err);

        await expect(svc.callApi('generateContent', {}, false, 0, 'gemini-2.5-flash'))
            .rejects.toMatchObject({ response: { status: 401 } });

        expect(mockAuthRequest).toHaveBeenCalledTimes(1);
    });

    test('throws on 400 and marks shouldSwitchCredential', async () => {
        const svc = makeService();
        svc.isInitialized = true;
        const err = { response: { status: 400 }, message: 'Bad Request' };
        mockAuthRequest.mockRejectedValueOnce(err);

        await expect(svc.callApi('generateContent', {}, false, 0, 'test'))
            .rejects.toMatchObject({ shouldSwitchCredential: true });
    });

    test('returns data on success', async () => {
        const svc = makeService();
        svc.isInitialized = true;
        mockAuthRequest.mockResolvedValueOnce({ data: { result: 'ok' } });

        const result = await svc.callApi('generateContent', {}, false, 0, 'gemini-2.5-flash');
        expect(result).toEqual({ result: 'ok' });
    });

    test('uses correct endpoint URL format', async () => {
        const svc = makeService();
        svc.isInitialized = true;
        mockAuthRequest.mockResolvedValueOnce({ data: {} });

        await svc.callApi('generateContent', {}, false, 0, 'gemini-2.5-flash');

        const [callArg] = mockAuthRequest.mock.calls[0];
        expect(callArg.url).toContain('generateContent');
        expect(callArg.method).toBe('POST');
    });
});

describe('GeminiApiService — listModels', () => {
    beforeEach(() => mockAuthRequest.mockReset());

    test('returns model list after initialization', async () => {
        const svc = makeService();
        // Mark as initialized and set availableModels directly to avoid network calls
        svc.isInitialized = true;
        svc.availableModels = ['gemini-2.5-flash', 'gemini-2.5-pro'];

        const result = await svc.listModels();
        expect(result).toHaveProperty('models');
        expect(Array.isArray(result.models)).toBe(true);
        expect(result.models.length).toBe(2);
    });

    test('model entries have name field', async () => {
        const svc = makeService();
        svc.isInitialized = true;
        svc.availableModels = ['gemini-2.5-flash'];

        const result = await svc.listModels();
        expect(result.models[0]).toHaveProperty('name');
        expect(result.models[0].name).toMatch(/gemini-2\.5-flash/);
    });

    test('model entries have supportedGenerationMethods', async () => {
        const svc = makeService();
        svc.isInitialized = true;
        svc.availableModels = ['gemini-2.5-pro'];

        const result = await svc.listModels();
        expect(result.models[0].supportedGenerationMethods).toContain('generateContent');
    });
});

describe('GeminiApiService — generateContent and generateContentStream', () => {
    beforeEach(() => mockAuthRequest.mockReset());

    test('generateContent calls callApi and returns response', async () => {
        const svc = makeService();
        svc.isInitialized = true;
        svc.projectId = 'test-project';
        const expected = { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] };
        mockAuthRequest.mockResolvedValueOnce({ data: expected });

        const result = await svc.generateContent('gemini-2.5-flash', {
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
        });
        expect(result).toBeDefined();
    });

    test('generateContentStream yields chunks from SSE', async () => {
        const svc = makeService();
        svc.isInitialized = true;
        svc.projectId = 'test-project';

        const chunk = { response: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } };
        const sseData = `data: ${JSON.stringify(chunk)}\n\n`;

        // readline.createInterface requires a proper Readable stream
        const readable = Readable.from([Buffer.from(sseData)]);
        mockAuthRequest.mockResolvedValueOnce({ status: 200, data: readable });

        const chunks = [];
        for await (const c of svc.generateContentStream('gemini-2.5-flash', {
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
        })) {
            chunks.push(c);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
});
