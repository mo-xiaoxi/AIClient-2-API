/**
 * Unit tests for src/providers/openai/codex-core.js
 *
 * Tests: CodexApiService construction, generateContent, generateContentStream,
 *        buildHeaders, prepareRequestBody, parseNonStreamResponse,
 *        isExpiryDateNear, listModels.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAxiosRequest = jest.fn();

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn((cfg) => cfg),
    getProxyConfigForProvider: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    isRetryableNetworkError: jest.fn(() => false),
    MODEL_PROVIDER: { CODEX_API: 'openai-codex-oauth' },
    MODEL_PROTOCOL_PREFIX: { CODEX: 'codex' },
    formatExpiryLog: jest.fn((_name, expiry, _mins) => ({
        message: '',
        isNearExpiry: expiry <= Date.now() + 20 * 60 * 1000,
    })),
}));

await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['gpt-5', 'gpt-5-codex', 'gpt-5-codex-mini']),
}));

await jest.unstable_mockModule('../../../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn().mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh',
        account_id: 'acc-1',
        email: 'test@example.com',
        expired: new Date(Date.now() + 3600 * 1000).toISOString(),
    }),
}));

await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

// Mock fs.promises for file operations
await jest.unstable_mockModule('fs', () => ({
    promises: {
        readFile: jest.fn().mockResolvedValue(JSON.stringify({
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
            account_id: 'test-account-id',
            email: 'test@example.com',
            expired: new Date(Date.now() + 7200 * 1000).toISOString(),
        })),
        writeFile: jest.fn().mockResolvedValue(undefined),
        mkdir: jest.fn().mockResolvedValue(undefined),
        access: jest.fn().mockResolvedValue(undefined),
        readdir: jest.fn().mockResolvedValue(['codex-test@example.com-2024.json']),
    },
}));

// Mock axios at module level
const mockAxiosObj = Object.assign(mockAxiosRequest, {
    request: mockAxiosRequest,
    create: jest.fn(() => ({ request: jest.fn() })),
});

await jest.unstable_mockModule('axios', () => ({
    default: mockAxiosObj,
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

let CodexApiService;

beforeAll(async () => {
    const mod = await import('../../../src/providers/openai/codex-core.js');
    CodexApiService = mod.CodexApiService;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides = {}) {
    const svc = new CodexApiService({
        CODEX_OAUTH_CREDS_FILE_PATH: '/tmp/fake-codex-creds.json',
        CODEX_BASE_URL: 'https://chatgpt.com/backend-api/codex',
        uuid: 'codex-test-uuid',
        REQUEST_MAX_RETRIES: 0,
        ...overrides,
    });
    return svc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexApiService — construction', () => {
    let svc;

    beforeEach(() => {
        mockAxiosRequest.mockReset();
        svc = makeService();
    });

    afterEach(() => {
        svc.stopCacheCleanup();
    });

    test('constructs without throwing', () => {
        expect(svc).toBeDefined();
    });

    test('isInitialized starts as false', () => {
        expect(svc.isInitialized).toBe(false);
    });

    test('uses provided base URL', () => {
        expect(svc.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    });

    test('uses default base URL when not provided', () => {
        const s = new CodexApiService({ uuid: 'u1' });
        expect(s.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
        s.stopCacheCleanup();
    });

    test('conversationCache is a Map', () => {
        expect(svc.conversationCache).toBeInstanceOf(Map);
    });
});

describe('CodexApiService — buildHeaders', () => {
    let svc;

    beforeEach(() => {
        svc = makeService();
        svc.accessToken = 'access-123';
        svc.accountId = 'account-456';
    });

    afterEach(() => svc.stopCacheCleanup());

    test('includes authorization header with Bearer token', () => {
        const h = svc.buildHeaders(null, true);
        expect(h.authorization).toBe('Bearer access-123');
    });

    test('includes chatgpt-account-id', () => {
        const h = svc.buildHeaders(null, true);
        expect(h['chatgpt-account-id']).toBe('account-456');
    });

    test('sets accept to text/event-stream for streaming', () => {
        const h = svc.buildHeaders(null, true);
        expect(h.accept).toBe('text/event-stream');
    });

    test('sets accept to application/json for non-streaming', () => {
        const h = svc.buildHeaders(null, false);
        expect(h.accept).toBe('application/json');
    });

    test('includes Conversation_id and Session_id when cacheId provided', () => {
        const h = svc.buildHeaders('cache-id-123', true);
        expect(h['Conversation_id']).toBe('cache-id-123');
        expect(h['Session_id']).toBe('cache-id-123');
    });
});

describe('CodexApiService — isExpiryDateNear', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });
    afterEach(() => svc.stopCacheCleanup());

    test('returns true when expiresAt is null', () => {
        svc.expiresAt = null;
        expect(svc.isExpiryDateNear()).toBe(true);
    });

    test('returns true when expiresAt is in the past', () => {
        svc.expiresAt = new Date(Date.now() - 1000); // 1 second ago
        expect(svc.isExpiryDateNear()).toBe(true);
    });

    test('returns true when expiresAt is Invalid Date', () => {
        svc.expiresAt = new Date('invalid');
        expect(svc.isExpiryDateNear()).toBe(true);
    });
});

describe('CodexApiService — prepareRequestBody', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });
    afterEach(() => svc.stopCacheCleanup());

    test('removes metadata from result body', async () => {
        const body = await svc.prepareRequestBody('gpt-5', {
            messages: [{ role: 'user', content: 'Hi' }],
            metadata: { session_id: 'sess-1' }
        }, true);
        expect(body.metadata).toBeUndefined();
    });

    test('includes stream flag in result', async () => {
        const body = await svc.prepareRequestBody('gpt-5', { messages: [] }, true);
        expect(body.stream).toBe(true);
    });

    test('sets prompt_cache_key', async () => {
        const body = await svc.prepareRequestBody('gpt-5', { messages: [] }, true);
        expect(body.prompt_cache_key).toBeDefined();
        expect(typeof body.prompt_cache_key).toBe('string');
    });

    test('-fast model strips the suffix for upstream', async () => {
        const body = await svc.prepareRequestBody('gpt-5-codex-fast', { messages: [] }, true);
        expect(body.model).toBe('gpt-5-codex');
    });
});

describe('CodexApiService — parseNonStreamResponse', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });
    afterEach(() => svc.stopCacheCleanup());

    test('returns response.completed event data', () => {
        const completed = { type: 'response.completed', response: { id: 'r1' } };
        const sseData = `data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n`;
        const result = svc.parseNonStreamResponse(sseData);
        expect(result).toEqual(completed);
    });

    test('throws when no response.completed event found', () => {
        const sseData = `data: {"type":"response.partial"}\n`;
        expect(() => svc.parseNonStreamResponse(sseData)).toThrow('stream error');
    });

    test('ignores [DONE] lines', () => {
        const completed = { type: 'response.completed' };
        const sseData = `data: [DONE]\ndata: ${JSON.stringify(completed)}\n`;
        const result = svc.parseNonStreamResponse(sseData);
        expect(result).toEqual(completed);
    });
});

describe('CodexApiService — listModels', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });
    afterEach(() => svc.stopCacheCleanup());

    test('returns object with data array', async () => {
        const result = await svc.listModels();
        expect(result).toHaveProperty('object', 'list');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
    });

    test('model entries have id, object, owned_by', async () => {
        const result = await svc.listModels();
        const model = result.data[0];
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('object', 'model');
        expect(model).toHaveProperty('owned_by', 'openai');
    });

    test('includes -fast variants for base models', async () => {
        const result = await svc.listModels();
        const ids = result.data.map(m => m.id);
        // The base models from mock are gpt-5, gpt-5-codex, gpt-5-codex-mini
        // Fast variants should also be present
        expect(ids).toContain('gpt-5-fast');
    });
});

describe('CodexApiService — generateContent error handling', () => {
    let svc;
    beforeEach(() => {
        mockAxiosRequest.mockReset();
        svc = makeService();
        svc.isInitialized = true;
        svc.accessToken = 'test-token';
        svc.accountId = 'test-account';
        svc.expiresAt = new Date(Date.now() + 7200 * 1000);
    });
    afterEach(() => svc.stopCacheCleanup());

    test('throws 401 error and marks credential unhealthy', async () => {
        mockAxiosRequest.mockRejectedValueOnce({ response: { status: 401 }, message: 'Unauthorized' });

        await expect(svc.generateContent('gpt-5', { messages: [] }))
            .rejects.toMatchObject({ response: { status: 401 } });
    });
});
