/**
 * Unit tests for request-handler.js
 *
 * Tests: createRequestHandler — CORS preflight, static file serving,
 *        health check endpoint, Model-Provider header override,
 *        URL path prefix provider selection, invalid provider rejection,
 *        auth middleware flow, count_tokens endpoint, 404 fallback,
 *        handleAPIRequests delegation.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Controllable mock state
// ---------------------------------------------------------------------------
const mockServeStaticFiles = jest.fn(async () => false);
const mockHandleUIApiRequests = jest.fn(async () => false);
const mockHandleAPIRequests = jest.fn(async () => false);
const mockGetApiService = jest.fn(async () => ({}));
const mockGetProviderStatus = jest.fn(async () => ({
    providerPoolsSlim: [], count: 0, unhealthyCount: 0, unhealthyRatio: 0, unhealthySummeryMessage: ''
}));
const mockGetRegisteredProviders = jest.fn(() => ['gemini-cli-oauth', 'openai-custom', 'forward-api']);
const mockGetProviderPoolManager = jest.fn(() => null);
const mockCountTokensAnthropic = jest.fn(() => ({ input_tokens: 10 }));
const mockHandleError = jest.fn();
const mockGetClientIp = jest.fn(() => '127.0.0.1');
const mockHandleGrokAssetsProxy = jest.fn(async () => undefined);

// Plugin manager mock (controllable per test)
const mockPluginManager = {
    isPluginStaticPath: jest.fn(() => false),
    executeRoutes: jest.fn(async () => false),
    executeAuth: jest.fn(async () => ({ handled: false, authorized: true })),
    executeMiddleware: jest.fn(async () => ({ handled: false })),
};
const mockGetPluginManager = jest.fn(() => mockPluginManager);

// Logger mock with runWithContext that just calls the callback
const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    runWithContext: jest.fn(async (id, fn) => fn()),
    clearRequestContext: jest.fn(),
};

// ---------------------------------------------------------------------------
// Module reference
// ---------------------------------------------------------------------------
let createRequestHandler;
const PROMPT_LOG_FILENAME_VALUE = 'test-log.txt';

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: mockLogger,
    }));

    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        handleError: mockHandleError,
        getClientIp: mockGetClientIp,
        MODEL_PROVIDER: {
            GEMINI_CLI: 'gemini-cli-oauth',
            OPENAI_CUSTOM: 'openai-custom',
            FORWARD_API: 'forward-api',
            AUTO: 'auto',
        },
    }));

    await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
        handleUIApiRequests: mockHandleUIApiRequests,
        serveStaticFiles: mockServeStaticFiles,
    }));

    await jest.unstable_mockModule('../../../src/services/api-manager.js', () => ({
        handleAPIRequests: mockHandleAPIRequests,
    }));

    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        getApiService: mockGetApiService,
        getProviderStatus: mockGetProviderStatus,
        getProviderPoolManager: mockGetProviderPoolManager,
    }));

    await jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
        getRegisteredProviders: mockGetRegisteredProviders,
    }));

    await jest.unstable_mockModule('../../../src/utils/token-utils.js', () => ({
        countTokensAnthropic: mockCountTokensAnthropic,
    }));

    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        PROMPT_LOG_FILENAME: PROMPT_LOG_FILENAME_VALUE,
    }));

    await jest.unstable_mockModule('../../../src/core/plugin-manager.js', () => ({
        getPluginManager: mockGetPluginManager,
    }));

    await jest.unstable_mockModule('../../../src/utils/grok-assets-proxy.js', () => ({
        handleGrokAssetsProxy: mockHandleGrokAssetsProxy,
    }));

    // deepmerge needs to be available — use a simple passthrough mock
    await jest.unstable_mockModule('deepmerge', () => ({
        __esModule: true,
        default: (target, source) => ({ ...target, ...source }),
    }));

    const mod = await import('../../../src/handlers/request-handler.js');
    createRequestHandler = mod.createRequestHandler;
});

beforeEach(() => {
    jest.clearAllMocks();
    // Reset all mocks to safe defaults
    mockLogger.runWithContext.mockImplementation(async (id, fn) => fn());
    mockServeStaticFiles.mockResolvedValue(false);
    mockHandleUIApiRequests.mockResolvedValue(false);
    mockHandleAPIRequests.mockResolvedValue(false);
    mockGetRegisteredProviders.mockReturnValue(['gemini-cli-oauth', 'openai-custom', 'forward-api']);
    mockGetPluginManager.mockReturnValue(mockPluginManager);
    mockPluginManager.isPluginStaticPath.mockReturnValue(false);
    mockPluginManager.executeRoutes.mockResolvedValue(false);
    mockPluginManager.executeAuth.mockResolvedValue({ handled: false, authorized: true });
    mockPluginManager.executeMiddleware.mockResolvedValue({ handled: false });
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockHandleGrokAssetsProxy.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeReq(method, url, headers = {}) {
    const emitter = new EventEmitter();
    emitter.method = method;
    emitter.url = url;
    emitter.headers = { host: 'localhost:3000', ...headers };
    emitter.socket = { encrypted: false };
    return emitter;
}

function makeRes() {
    const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
        setHeader: jest.fn(),
        finished: false,
    };
    return res;
}

function makeHandler(config = {}) {
    const cfg = { MODEL_PROVIDER: 'gemini-cli-oauth', ...config };
    return createRequestHandler(cfg, null);
}

// ---------------------------------------------------------------------------
// Tests: CORS preflight
// ---------------------------------------------------------------------------
describe('createRequestHandler — CORS preflight', () => {
    test('OPTIONS request returns 204 and does not call API handler', async () => {
        const handler = makeHandler();
        const req = makeReq('OPTIONS', '/v1/chat/completions');
        const res = makeRes();
        await handler(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(204);
        expect(res.end).toHaveBeenCalled();
        expect(mockHandleAPIRequests).not.toHaveBeenCalled();
    });

    test('all requests get CORS headers', async () => {
        const handler = makeHandler();
        const req = makeReq('GET', '/health');
        const res = makeRes();
        await handler(req, res);
        expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    });
});

// ---------------------------------------------------------------------------
// Tests: health check endpoint
// ---------------------------------------------------------------------------
describe('createRequestHandler — GET /health', () => {
    test('returns 200 with status:healthy JSON', async () => {
        const handler = makeHandler();
        const req = makeReq('GET', '/health');
        const res = makeRes();
        await handler(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'application/json' }));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.status).toBe('healthy');
        expect(body.timestamp).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Tests: static file serving
// ---------------------------------------------------------------------------
describe('createRequestHandler — static files', () => {
    test('serves static file when serveStaticFiles returns true', async () => {
        mockServeStaticFiles.mockResolvedValue(true);
        const handler = makeHandler();
        const req = makeReq('GET', '/static/app.js');
        const res = makeRes();
        await handler(req, res);
        expect(mockHandleAPIRequests).not.toHaveBeenCalled();
    });

    test('continues pipeline when serveStaticFiles returns false', async () => {
        mockServeStaticFiles.mockResolvedValue(false);
        mockHandleAPIRequests.mockResolvedValue(true);
        const handler = makeHandler();
        const req = makeReq('GET', '/static/app.js');
        const res = makeRes();
        await handler(req, res);
        // handleAPIRequests was reached (after auth etc.)
        expect(mockHandleAPIRequests).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: Model-Provider header override
// ---------------------------------------------------------------------------
describe('createRequestHandler — Model-Provider header override', () => {
    test('overrides MODEL_PROVIDER when header contains valid provider', async () => {
        mockHandleAPIRequests.mockResolvedValue(true);
        const handler = makeHandler({ MODEL_PROVIDER: 'gemini-cli-oauth' });
        const req = makeReq('POST', '/v1/chat/completions', { 'model-provider': 'openai-custom' });
        const res = makeRes();
        await handler(req, res);
        // The config passed to handleAPIRequests should have openai-custom
        const configArg = mockHandleAPIRequests.mock.calls[0][4];
        expect(configArg.MODEL_PROVIDER).toBe('openai-custom');
    });

    test('returns 400 when model-provider header has unregistered provider', async () => {
        const handler = makeHandler();
        const req = makeReq('POST', '/v1/chat/completions', { 'model-provider': 'bad-provider' });
        const res = makeRes();
        await handler(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('bad-provider');
    });
});

// ---------------------------------------------------------------------------
// Tests: URL path prefix provider selection
// ---------------------------------------------------------------------------
describe('createRequestHandler — URL path prefix provider selection', () => {
    test('uses path segment as provider when it matches registered provider', async () => {
        mockHandleAPIRequests.mockResolvedValue(true);
        const handler = makeHandler({ MODEL_PROVIDER: 'gemini-cli-oauth' });
        const req = makeReq('POST', '/openai-custom/v1/chat/completions');
        const res = makeRes();
        await handler(req, res);
        const configArg = mockHandleAPIRequests.mock.calls[0][4];
        expect(configArg.MODEL_PROVIDER).toBe('openai-custom');
    });

    test('strips provider prefix from path before delegating', async () => {
        mockHandleAPIRequests.mockResolvedValue(true);
        const handler = makeHandler({ MODEL_PROVIDER: 'gemini-cli-oauth' });
        const req = makeReq('POST', '/openai-custom/v1/chat/completions');
        const res = makeRes();
        await handler(req, res);
        // path passed to handleAPIRequests should be /v1/chat/completions
        const pathArg = mockHandleAPIRequests.mock.calls[0][1];
        expect(pathArg).toBe('/v1/chat/completions');
    });

    test('ignores path segment that is not a provider', async () => {
        mockHandleAPIRequests.mockResolvedValue(true);
        const handler = makeHandler();
        const req = makeReq('GET', '/v1/models');
        const res = makeRes();
        await handler(req, res);
        const pathArg = mockHandleAPIRequests.mock.calls[0][1];
        expect(pathArg).toBe('/v1/models');
    });
});

// ---------------------------------------------------------------------------
// Tests: auth middleware flow
// ---------------------------------------------------------------------------
describe('createRequestHandler — authentication', () => {
    test('returns 401 when auth plugin reports not authorized', async () => {
        mockPluginManager.executeAuth.mockResolvedValue({ handled: false, authorized: false });
        const handler = makeHandler();
        const req = makeReq('POST', '/v1/chat/completions');
        const res = makeRes();
        await handler(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('Unauthorized');
    });

    test('proceeds past auth when authorized', async () => {
        mockPluginManager.executeAuth.mockResolvedValue({ handled: false, authorized: true });
        mockHandleAPIRequests.mockResolvedValue(true);
        const handler = makeHandler();
        const req = makeReq('POST', '/v1/chat/completions');
        const res = makeRes();
        await handler(req, res);
        expect(mockHandleAPIRequests).toHaveBeenCalled();
    });

    test('stops pipeline when auth plugin sets handled:true', async () => {
        mockPluginManager.executeAuth.mockResolvedValue({ handled: true, authorized: false });
        const handler = makeHandler();
        const req = makeReq('POST', '/v1/chat/completions');
        const res = makeRes();
        await handler(req, res);
        expect(mockHandleAPIRequests).not.toHaveBeenCalled();
    });

    test('stops pipeline when middleware sets handled:true', async () => {
        mockPluginManager.executeAuth.mockResolvedValue({ handled: false, authorized: true });
        mockPluginManager.executeMiddleware.mockResolvedValue({ handled: true });
        const handler = makeHandler();
        const req = makeReq('POST', '/v1/chat/completions');
        const res = makeRes();
        await handler(req, res);
        expect(mockHandleAPIRequests).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: 404 fallback
// ---------------------------------------------------------------------------
describe('createRequestHandler — 404 fallback', () => {
    test('returns 404 when handleAPIRequests returns false', async () => {
        mockHandleAPIRequests.mockResolvedValue(false);
        const handler = makeHandler();
        const req = makeReq('GET', '/unknown/route');
        const res = makeRes();
        await handler(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toBe('Not Found');
    });
});

// ---------------------------------------------------------------------------
// Tests: count_tokens endpoint
// ---------------------------------------------------------------------------
describe('createRequestHandler — POST count_tokens', () => {
    test('handles count_tokens request and returns token count', async () => {
        mockCountTokensAnthropic.mockReturnValue({ input_tokens: 42 });
        const handler = makeHandler();
        const req = makeReq('POST', '/v1/count_tokens');
        const res = makeRes();

        // Simulate request body
        process.nextTick(() => {
            req.emit('data', JSON.stringify({ model: 'claude-3', messages: [] }));
            req.emit('end');
        });

        await handler(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.input_tokens).toBe(42);
    });

    test('returns 0 tokens when countTokensAnthropic throws', async () => {
        mockCountTokensAnthropic.mockImplementation(() => { throw new Error('Token error'); });
        const handler = makeHandler();
        const req = makeReq('POST', '/v1/count_tokens');
        const res = makeRes();

        process.nextTick(() => {
            req.emit('data', JSON.stringify({ model: 'claude-3' }));
            req.emit('end');
        });

        await handler(req, res);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.input_tokens).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Tests: plugin route handling
// ---------------------------------------------------------------------------
describe('createRequestHandler — plugin routes', () => {
    test('stops pipeline when plugin route is handled', async () => {
        mockPluginManager.executeRoutes.mockResolvedValue(true);
        const handler = makeHandler();
        const req = makeReq('GET', '/plugin-route');
        const res = makeRes();
        await handler(req, res);
        expect(mockHandleAPIRequests).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: UI requests
// ---------------------------------------------------------------------------
describe('createRequestHandler — UI requests', () => {
    test('stops pipeline when UI handler returns true', async () => {
        mockHandleUIApiRequests.mockResolvedValue(true);
        const handler = makeHandler();
        const req = makeReq('GET', '/api/ui/something');
        const res = makeRes();
        await handler(req, res);
        expect(mockHandleAPIRequests).not.toHaveBeenCalled();
    });
});
