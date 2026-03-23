/**
 * Unit tests for plugins/ai-monitor/index.js
 *
 * Tests: middleware(), hooks.onContentGenerated(), hooks.onUnaryResponse(),
 *        hooks.onStreamChunk(), hooks.onInternalRequestConverted()
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let aiMonitorPlugin;
let mockLogger;

beforeAll(async () => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: mockLogger,
    }));

    const mod = await import('../../../src/plugins/ai-monitor/index.js');
    aiMonitorPlugin = mod.default;
});

beforeEach(() => {
    jest.clearAllMocks();
    // Clear stream cache between tests
    aiMonitorPlugin.streamCache.clear();
});

// Helper to build a minimal URL object
function makeUrl(pathname = '/v1/chat/completions') {
    return { pathname };
}

// =============================================================================
// Plugin metadata
// =============================================================================

describe('aiMonitorPlugin metadata', () => {
    test('has correct name', () => {
        expect(aiMonitorPlugin.name).toBe('ai-monitor');
    });

    test('has type middleware', () => {
        expect(aiMonitorPlugin.type).toBe('middleware');
    });

    test('has hooks object', () => {
        expect(typeof aiMonitorPlugin.hooks).toBe('object');
    });

    test('has streamCache Map', () => {
        expect(aiMonitorPlugin.streamCache instanceof Map).toBe(true);
    });
});

// =============================================================================
// middleware()
// =============================================================================

describe('middleware()', () => {
    test('returns handled: false for AI path POST', async () => {
        const req = { method: 'POST' };
        const config = {};
        const result = await aiMonitorPlugin.middleware(req, {}, makeUrl('/v1/chat/completions'), config);
        expect(result.handled).toBe(false);
    });

    test('sets _monitorRequestId on config for AI POST requests', async () => {
        const req = { method: 'POST' };
        const config = {};
        await aiMonitorPlugin.middleware(req, {}, makeUrl('/v1/chat/completions'), config);
        expect(config._monitorRequestId).toBeDefined();
    });

    test('does not set _monitorRequestId for non-AI paths', async () => {
        const req = { method: 'POST' };
        const config = {};
        await aiMonitorPlugin.middleware(req, {}, makeUrl('/health'), config);
        expect(config._monitorRequestId).toBeUndefined();
    });

    test('does not set _monitorRequestId for GET requests on AI paths', async () => {
        const req = { method: 'GET' };
        const config = {};
        await aiMonitorPlugin.middleware(req, {}, makeUrl('/v1/chat/completions'), config);
        expect(config._monitorRequestId).toBeUndefined();
    });

    test('returns handled: false for non-AI paths too', async () => {
        const req = { method: 'GET' };
        const result = await aiMonitorPlugin.middleware(req, {}, makeUrl('/health'), {});
        expect(result.handled).toBe(false);
    });
});

// =============================================================================
// hooks.onContentGenerated()
// =============================================================================

describe('hooks.onContentGenerated()', () => {
    test('does nothing when originalRequestBody is absent', async () => {
        // Should not throw
        await aiMonitorPlugin.hooks.onContentGenerated({});
    });

    test('logs request info via setImmediate when originalRequestBody is present', async () => {
        const config = {
            originalRequestBody: { messages: [] },
            processedRequestBody: { messages: [] },
            fromProvider: 'openai',
            toProvider: 'gemini',
            model: 'gemini-pro',
            _monitorRequestId: 'req-001',
            isStream: false,
        };
        await aiMonitorPlugin.hooks.onContentGenerated(config);
        // Wait for setImmediate
        await new Promise(r => setImmediate(r));
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test('schedules stream aggregation log when isStream is true', async () => {
        const requestId = 'stream-req-001';
        // Pre-populate stream cache
        aiMonitorPlugin.streamCache.set(requestId, {
            nativeChunks: ['chunk1'],
            convertedChunks: ['converted1'],
            fromProvider: 'openai',
            toProvider: 'gemini',
        });

        const config = {
            originalRequestBody: { messages: [] },
            processedRequestBody: { messages: [] },
            fromProvider: 'openai',
            toProvider: 'gemini',
            model: 'test-model',
            _monitorRequestId: requestId,
            isStream: true,
        };

        await aiMonitorPlugin.hooks.onContentGenerated(config);
        // Wait for setTimeout(2000) — use fake timers approach
        await new Promise(r => setImmediate(r));
        // The cache entry may still exist (timer hasn't fired yet), but call should not throw
    });
});

// =============================================================================
// hooks.onStreamChunk()
// =============================================================================

describe('hooks.onStreamChunk()', () => {
    test('does nothing when requestId is absent', async () => {
        await aiMonitorPlugin.hooks.onStreamChunk({
            nativeChunk: 'chunk',
            chunkToSend: 'converted',
            fromProvider: 'openai',
            toProvider: 'gemini',
        });
        // No throw, no cache entry
        expect(aiMonitorPlugin.streamCache.size).toBe(0);
    });

    test('creates cache entry on first chunk', async () => {
        await aiMonitorPlugin.hooks.onStreamChunk({
            requestId: 'req-stream-1',
            nativeChunk: 'native1',
            chunkToSend: 'converted1',
            fromProvider: 'openai',
            toProvider: 'gemini',
        });
        expect(aiMonitorPlugin.streamCache.has('req-stream-1')).toBe(true);
    });

    test('accumulates chunks across multiple calls', async () => {
        const reqId = 'req-stream-2';
        await aiMonitorPlugin.hooks.onStreamChunk({ requestId: reqId, nativeChunk: 'n1', chunkToSend: 'c1', fromProvider: 'a', toProvider: 'b' });
        await aiMonitorPlugin.hooks.onStreamChunk({ requestId: reqId, nativeChunk: 'n2', chunkToSend: 'c2', fromProvider: 'a', toProvider: 'b' });

        const cache = aiMonitorPlugin.streamCache.get(reqId);
        expect(cache.nativeChunks).toHaveLength(2);
        expect(cache.convertedChunks).toHaveLength(2);
    });

    test('handles array chunks by spreading into cache', async () => {
        const reqId = 'req-stream-3';
        await aiMonitorPlugin.hooks.onStreamChunk({
            requestId: reqId,
            nativeChunk: ['a', 'b', null],
            chunkToSend: ['x', 'y'],
            fromProvider: 'openai',
            toProvider: 'gemini',
        });
        const cache = aiMonitorPlugin.streamCache.get(reqId);
        // null should be filtered out
        expect(cache.nativeChunks).toEqual(['a', 'b']);
        expect(cache.convertedChunks).toEqual(['x', 'y']);
    });

    test('ignores null chunk values', async () => {
        const reqId = 'req-stream-4';
        await aiMonitorPlugin.hooks.onStreamChunk({
            requestId: reqId,
            nativeChunk: null,
            chunkToSend: null,
            fromProvider: 'openai',
            toProvider: 'gemini',
        });
        const cache = aiMonitorPlugin.streamCache.get(reqId);
        expect(cache.nativeChunks).toHaveLength(0);
        expect(cache.convertedChunks).toHaveLength(0);
    });
});

// =============================================================================
// hooks.onUnaryResponse()
// =============================================================================

describe('hooks.onUnaryResponse()', () => {
    test('logs via setImmediate without throwing', async () => {
        await aiMonitorPlugin.hooks.onUnaryResponse({
            nativeResponse: { result: 'native' },
            clientResponse: { result: 'converted' },
            fromProvider: 'gemini',
            toProvider: 'openai',
            requestId: 'req-unary-1',
        });
        await new Promise(r => setImmediate(r));
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test('uses N/A as requestId when not provided', async () => {
        await aiMonitorPlugin.hooks.onUnaryResponse({
            nativeResponse: {},
            clientResponse: {},
            fromProvider: 'gemini',
            toProvider: 'openai',
        });
        await new Promise(r => setImmediate(r));
        const calls = mockLogger.info.mock.calls;
        expect(calls.some(args => String(args[0]).includes('N/A'))).toBe(true);
    });
});

// =============================================================================
// hooks.onInternalRequestConverted()
// =============================================================================

describe('hooks.onInternalRequestConverted()', () => {
    test('logs converter name via setImmediate', async () => {
        await aiMonitorPlugin.hooks.onInternalRequestConverted({
            requestId: 'req-conv-1',
            internalRequest: { model: 'gemini-pro' },
            converterName: 'GeminiConverter',
        });
        await new Promise(r => setImmediate(r));
        expect(mockLogger.info).toHaveBeenCalled();
        const calls = mockLogger.info.mock.calls;
        expect(calls.some(args => String(args[0]).includes('GeminiConverter'))).toBe(true);
    });
});
