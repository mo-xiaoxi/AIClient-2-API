/**
 * Unit tests for api-manager.js
 *
 * Tests: handleAPIRequests routing (GET /v1/models, GET /v1beta/models,
 *        POST /v1/chat/completions, POST /v1/responses, POST /v1/messages,
 *        Gemini URL pattern, unknown path fallback),
 *        readRequestBody helper, initializeAPIManagement heartbeat.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Controllable mock functions
// ---------------------------------------------------------------------------
const mockHandleModelListRequest = jest.fn();
const mockHandleContentGenerationRequest = jest.fn();
const mockGetProviderPoolManager = jest.fn(() => null);

// ---------------------------------------------------------------------------
// Module references
// ---------------------------------------------------------------------------
let handleAPIRequests;
let readRequestBody;
let initializeAPIManagement;
let ENDPOINT_TYPE;
let API_ACTIONS;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        },
    }));

    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        handleModelListRequest: mockHandleModelListRequest,
        handleContentGenerationRequest: mockHandleContentGenerationRequest,
        API_ACTIONS: {
            GENERATE_CONTENT: 'generateContent',
            STREAM_GENERATE_CONTENT: 'streamGenerateContent',
        },
        ENDPOINT_TYPE: {
            OPENAI_MODEL_LIST: 'openai_model_list',
            GEMINI_MODEL_LIST: 'gemini_model_list',
            OPENAI_CHAT: 'openai_chat',
            OPENAI_RESPONSES: 'openai_responses',
            GEMINI_CONTENT: 'gemini_content',
            CLAUDE_MESSAGE: 'claude_message',
        },
    }));

    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        getProviderPoolManager: mockGetProviderPoolManager,
    }));

    const mod = await import('../../../src/services/api-manager.js');
    handleAPIRequests = mod.handleAPIRequests;
    readRequestBody = mod.readRequestBody;
    initializeAPIManagement = mod.initializeAPIManagement;

    const commonMod = await import('../../../src/utils/common.js');
    ENDPOINT_TYPE = commonMod.ENDPOINT_TYPE;
    API_ACTIONS = commonMod.API_ACTIONS;
});

beforeEach(() => {
    mockHandleModelListRequest.mockReset();
    mockHandleContentGenerationRequest.mockReset();
    mockHandleModelListRequest.mockResolvedValue(undefined);
    mockHandleContentGenerationRequest.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeMockReq() {
    return {};
}

function makeMockRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
        setHeader: jest.fn(),
    };
}

// ---------------------------------------------------------------------------
// Tests: GET /v1/models
// ---------------------------------------------------------------------------
describe('handleAPIRequests — GET /v1/models', () => {
    test('routes GET /v1/models to handleModelListRequest with OPENAI_MODEL_LIST', async () => {
        const handled = await handleAPIRequests('GET', '/v1/models', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(true);
        expect(mockHandleModelListRequest).toHaveBeenCalledTimes(1);
        expect(mockHandleModelListRequest.mock.calls[0][3]).toBe(ENDPOINT_TYPE.OPENAI_MODEL_LIST);
    });

    test('routes GET /v1beta/models to handleModelListRequest with GEMINI_MODEL_LIST', async () => {
        const handled = await handleAPIRequests('GET', '/v1beta/models', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(true);
        expect(mockHandleModelListRequest.mock.calls[0][3]).toBe(ENDPOINT_TYPE.GEMINI_MODEL_LIST);
    });
});

// ---------------------------------------------------------------------------
// Tests: POST content generation routes
// ---------------------------------------------------------------------------
describe('handleAPIRequests — POST /v1/chat/completions', () => {
    test('routes to handleContentGenerationRequest with OPENAI_CHAT type', async () => {
        const handled = await handleAPIRequests('POST', '/v1/chat/completions', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(true);
        expect(mockHandleContentGenerationRequest).toHaveBeenCalledTimes(1);
        expect(mockHandleContentGenerationRequest.mock.calls[0][3]).toBe(ENDPOINT_TYPE.OPENAI_CHAT);
    });
});

describe('handleAPIRequests — POST /v1/responses', () => {
    test('routes to handleContentGenerationRequest with OPENAI_RESPONSES type', async () => {
        const handled = await handleAPIRequests('POST', '/v1/responses', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(true);
        expect(mockHandleContentGenerationRequest.mock.calls[0][3]).toBe(ENDPOINT_TYPE.OPENAI_RESPONSES);
    });
});

describe('handleAPIRequests — POST /v1/messages', () => {
    test('routes to handleContentGenerationRequest with CLAUDE_MESSAGE type', async () => {
        const handled = await handleAPIRequests('POST', '/v1/messages', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(true);
        expect(mockHandleContentGenerationRequest.mock.calls[0][3]).toBe(ENDPOINT_TYPE.CLAUDE_MESSAGE);
    });
});

describe('handleAPIRequests — Gemini URL pattern', () => {
    test('routes POST /v1beta/models/gemini-pro:generateContent to GEMINI_CONTENT', async () => {
        const path = '/v1beta/models/gemini-pro:generateContent';
        const handled = await handleAPIRequests('POST', path, makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(true);
        expect(mockHandleContentGenerationRequest.mock.calls[0][3]).toBe(ENDPOINT_TYPE.GEMINI_CONTENT);
    });

    test('routes POST /v1beta/models/gemini-pro:streamGenerateContent to GEMINI_CONTENT', async () => {
        const path = '/v1beta/models/gemini-pro:streamGenerateContent';
        const handled = await handleAPIRequests('POST', path, makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(true);
        expect(mockHandleContentGenerationRequest.mock.calls[0][3]).toBe(ENDPOINT_TYPE.GEMINI_CONTENT);
    });
});

// ---------------------------------------------------------------------------
// Tests: unmatched paths
// ---------------------------------------------------------------------------
describe('handleAPIRequests — unmatched routes', () => {
    test('returns false for unknown GET path', async () => {
        const handled = await handleAPIRequests('GET', '/unknown/path', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(false);
        expect(mockHandleModelListRequest).not.toHaveBeenCalled();
        expect(mockHandleContentGenerationRequest).not.toHaveBeenCalled();
    });

    test('returns false for unknown POST path', async () => {
        const handled = await handleAPIRequests('POST', '/not/an/api', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(false);
    });

    test('returns false for PUT method on known paths', async () => {
        const handled = await handleAPIRequests('PUT', '/v1/models', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(false);
    });

    test('returns false for DELETE method', async () => {
        const handled = await handleAPIRequests('DELETE', '/v1/chat/completions', makeMockReq(), makeMockRes(), {}, null, null, null);
        expect(handled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Tests: readRequestBody helper
// ---------------------------------------------------------------------------
describe('readRequestBody', () => {
    function makeReqWithBody(body) {
        const emitter = new EventEmitter();
        process.nextTick(() => {
            emitter.emit('data', body);
            emitter.emit('end');
        });
        return emitter;
    }

    function makeReqWithError(errMsg) {
        const emitter = new EventEmitter();
        process.nextTick(() => {
            emitter.emit('error', new Error(errMsg));
        });
        return emitter;
    }

    test('resolves with the body string', async () => {
        const req = makeReqWithBody('hello world');
        const body = await readRequestBody(req);
        expect(body).toBe('hello world');
    });

    test('resolves with empty string for empty body', async () => {
        const req = makeReqWithBody('');
        const body = await readRequestBody(req);
        expect(body).toBe('');
    });

    test('rejects on stream error', async () => {
        const req = makeReqWithError('stream error');
        await expect(readRequestBody(req)).rejects.toThrow('stream error');
    });

    test('concatenates multiple data chunks', async () => {
        const emitter = new EventEmitter();
        process.nextTick(() => {
            emitter.emit('data', 'foo');
            emitter.emit('data', 'bar');
            emitter.emit('end');
        });
        const body = await readRequestBody(emitter);
        expect(body).toBe('foobar');
    });
});

// ---------------------------------------------------------------------------
// Tests: initializeAPIManagement
// ---------------------------------------------------------------------------
describe('initializeAPIManagement', () => {
    test('returns a heartbeat function', () => {
        const heartbeat = initializeAPIManagement({});
        expect(typeof heartbeat).toBe('function');
    });

    test('heartbeat function can be called without errors', async () => {
        mockGetProviderPoolManager.mockReturnValue(null);
        const heartbeat = initializeAPIManagement({});
        await expect(heartbeat()).resolves.not.toThrow();
    });

    test('heartbeat calls refreshToken on services without uuid', async () => {
        mockGetProviderPoolManager.mockReturnValue(null);
        const refreshToken = jest.fn().mockResolvedValue(undefined);
        const services = {
            'provider-1': { refreshToken, config: {} },
        };
        const heartbeat = initializeAPIManagement(services);
        await heartbeat();
        expect(refreshToken).toHaveBeenCalledTimes(1);
    });

    test('heartbeat calls poolManager._enqueueRefresh for services with uuid', async () => {
        const enqueueRefresh = jest.fn();
        mockGetProviderPoolManager.mockReturnValue({ _enqueueRefresh: enqueueRefresh });
        const services = {
            'provider-1': { config: { uuid: 'my-uuid', MODEL_PROVIDER: 'openai-custom' } },
        };
        const heartbeat = initializeAPIManagement(services);
        await heartbeat();
        expect(enqueueRefresh).toHaveBeenCalledWith('openai-custom', expect.any(Object));
    });

    test('heartbeat logs error but continues when refreshToken throws', async () => {
        mockGetProviderPoolManager.mockReturnValue(null);
        const refreshToken = jest.fn().mockRejectedValue(new Error('token expired'));
        const services = {
            'provider-1': { refreshToken, config: {} },
        };
        const heartbeat = initializeAPIManagement(services);
        await expect(heartbeat()).resolves.not.toThrow();
    });
});
