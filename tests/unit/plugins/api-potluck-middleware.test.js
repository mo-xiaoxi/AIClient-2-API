/**
 * Unit tests for plugins/api-potluck/middleware.js
 *
 * Tests: extractPotluckKey(), isPotluckRequest(),
 *        potluckAuthMiddleware(), sendPotluckError()
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const KEY_PREFIX = 'maki_';
const VALID_KEY = `${KEY_PREFIX}abc123def456abc1`;

let extractPotluckKey;
let isPotluckRequest;
let potluckAuthMiddleware;
let sendPotluckError;

let mockValidateKey;
let mockLogger;

beforeAll(async () => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    mockValidateKey = jest.fn();

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: mockLogger,
    }));

    await jest.unstable_mockModule('../../../src/plugins/api-potluck/key-manager.js', () => ({
        __esModule: true,
        KEY_PREFIX,
        validateKey: mockValidateKey,
        incrementUsage: jest.fn().mockResolvedValue({}),
        createKey: jest.fn(),
        listKeys: jest.fn(),
        getKey: jest.fn(),
        deleteKey: jest.fn(),
        updateKeyLimit: jest.fn(),
        resetKeyUsage: jest.fn(),
        toggleKey: jest.fn(),
        updateKeyName: jest.fn(),
        getStats: jest.fn(),
        setConfigGetter: jest.fn(),
    }));

    const mod = await import('../../../src/plugins/api-potluck/middleware.js');
    extractPotluckKey = mod.extractPotluckKey;
    isPotluckRequest = mod.isPotluckRequest;
    potluckAuthMiddleware = mod.potluckAuthMiddleware;
    sendPotluckError = mod.sendPotluckError;
});

beforeEach(() => {
    jest.clearAllMocks();
});

// Helper builders
function makeReq(headers = {}) {
    return { headers };
}

function makeUrl(params = {}) {
    const search = new URLSearchParams(params);
    return new URL(`http://localhost/v1/chat/completions?${search.toString()}`);
}

function makeRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
        writableEnded: false,
        destroyed: false,
        headersSent: false,
    };
}

// =============================================================================
// extractPotluckKey
// =============================================================================

describe('extractPotluckKey()', () => {
    test('returns key from Authorization Bearer header', () => {
        const req = makeReq({ authorization: `Bearer ${VALID_KEY}` });
        expect(extractPotluckKey(req, makeUrl())).toBe(VALID_KEY);
    });

    test('returns null when Bearer token does not start with KEY_PREFIX', () => {
        const req = makeReq({ authorization: 'Bearer sk-notapotluckkey' });
        expect(extractPotluckKey(req, makeUrl())).toBeNull();
    });

    test('returns null when no Authorization header', () => {
        const req = makeReq({});
        expect(extractPotluckKey(req, makeUrl())).toBeNull();
    });

    test('returns key from x-api-key header', () => {
        const req = makeReq({ 'x-api-key': VALID_KEY });
        expect(extractPotluckKey(req, makeUrl())).toBe(VALID_KEY);
    });

    test('returns null when x-api-key does not start with KEY_PREFIX', () => {
        const req = makeReq({ 'x-api-key': 'sk-other' });
        expect(extractPotluckKey(req, makeUrl())).toBeNull();
    });

    test('returns key from x-goog-api-key header', () => {
        const req = makeReq({ 'x-goog-api-key': VALID_KEY });
        expect(extractPotluckKey(req, makeUrl())).toBe(VALID_KEY);
    });

    test('returns null when x-goog-api-key does not start with KEY_PREFIX', () => {
        const req = makeReq({ 'x-goog-api-key': 'AIzaXXXX' });
        expect(extractPotluckKey(req, makeUrl())).toBeNull();
    });

    test('returns key from URL query parameter', () => {
        const req = makeReq({});
        const url = makeUrl({ key: VALID_KEY });
        expect(extractPotluckKey(req, url)).toBe(VALID_KEY);
    });

    test('returns null when URL key param does not start with KEY_PREFIX', () => {
        const req = makeReq({});
        const url = makeUrl({ key: 'other-key' });
        expect(extractPotluckKey(req, url)).toBeNull();
    });

    test('returns null when no credentials at all', () => {
        const req = makeReq({});
        expect(extractPotluckKey(req, makeUrl())).toBeNull();
    });

    test('Authorization header takes priority over x-api-key', () => {
        const req = makeReq({
            authorization: `Bearer ${VALID_KEY}`,
            'x-api-key': `${KEY_PREFIX}other`,
        });
        expect(extractPotluckKey(req, makeUrl())).toBe(VALID_KEY);
    });
});

// =============================================================================
// isPotluckRequest
// =============================================================================

describe('isPotluckRequest()', () => {
    test('returns true when potluck key is present', () => {
        const req = makeReq({ authorization: `Bearer ${VALID_KEY}` });
        expect(isPotluckRequest(req, makeUrl())).toBe(true);
    });

    test('returns false when no potluck key is present', () => {
        const req = makeReq({});
        expect(isPotluckRequest(req, makeUrl())).toBe(false);
    });
});

// =============================================================================
// potluckAuthMiddleware
// =============================================================================

describe('potluckAuthMiddleware()', () => {
    test('returns authorized: null when no potluck key in request', async () => {
        const req = makeReq({});
        const result = await potluckAuthMiddleware(req, makeUrl());
        expect(result).toEqual({ authorized: null });
    });

    test('returns authorized: true when key is valid', async () => {
        mockValidateKey.mockResolvedValue({ valid: true, keyData: { id: VALID_KEY } });
        const req = makeReq({ authorization: `Bearer ${VALID_KEY}` });
        const result = await potluckAuthMiddleware(req, makeUrl());
        expect(result.authorized).toBe(true);
        expect(result.apiKey).toBe(VALID_KEY);
        expect(result.keyData).toBeDefined();
    });

    test('returns authorized: false with 401 for invalid_format', async () => {
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'invalid_format' });
        const req = makeReq({ authorization: `Bearer ${VALID_KEY}` });
        const result = await potluckAuthMiddleware(req, makeUrl());
        expect(result.authorized).toBe(false);
        expect(result.error.statusCode).toBe(401);
        expect(result.error.code).toBe('invalid_format');
    });

    test('returns authorized: false with 401 for not_found', async () => {
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'not_found' });
        const req = makeReq({ authorization: `Bearer ${VALID_KEY}` });
        const result = await potluckAuthMiddleware(req, makeUrl());
        expect(result.authorized).toBe(false);
        expect(result.error.statusCode).toBe(401);
        expect(result.error.code).toBe('not_found');
    });

    test('returns authorized: false with 403 for disabled', async () => {
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'disabled' });
        const req = makeReq({ authorization: `Bearer ${VALID_KEY}` });
        const result = await potluckAuthMiddleware(req, makeUrl());
        expect(result.authorized).toBe(false);
        expect(result.error.statusCode).toBe(403);
        expect(result.error.code).toBe('disabled');
    });

    test('returns authorized: false with 429 for quota_exceeded', async () => {
        mockValidateKey.mockResolvedValue({
            valid: false,
            reason: 'quota_exceeded',
            keyData: { todayUsage: 500, dailyLimit: 500, lastResetDate: '2026-03-23' },
        });
        const req = makeReq({ authorization: `Bearer ${VALID_KEY}` });
        const result = await potluckAuthMiddleware(req, makeUrl());
        expect(result.authorized).toBe(false);
        expect(result.error.statusCode).toBe(429);
    });

    test('defaults to 401 for unknown reason', async () => {
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'unknown_reason' });
        const req = makeReq({ authorization: `Bearer ${VALID_KEY}` });
        const result = await potluckAuthMiddleware(req, makeUrl());
        expect(result.error.statusCode).toBe(401);
    });
});

// =============================================================================
// sendPotluckError
// =============================================================================

describe('sendPotluckError()', () => {
    test('writes error response with correct status code', () => {
        const res = makeRes();
        sendPotluckError(res, { statusCode: 401, message: 'Not allowed', code: 'not_found' });
        expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
        expect(res.end).toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.code).toBe('not_found');
        expect(body.error.type).toBe('potluck_error');
    });

    test('includes quota info when code is quota_exceeded', () => {
        const res = makeRes();
        sendPotluckError(res, {
            statusCode: 429,
            message: 'Quota exceeded',
            code: 'quota_exceeded',
            keyData: { todayUsage: 100, dailyLimit: 100, lastResetDate: '2026-03-23' },
        });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.quota).toBeDefined();
        expect(body.error.quota.used).toBe(100);
        expect(body.error.quota.limit).toBe(100);
    });

    test('skips writing when response is already ended', () => {
        const res = makeRes();
        res.writableEnded = true;
        sendPotluckError(res, { statusCode: 401, message: 'x', code: 'not_found' });
        expect(res.writeHead).not.toHaveBeenCalled();
        expect(res.end).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('skips writing when response is destroyed', () => {
        const res = makeRes();
        res.destroyed = true;
        sendPotluckError(res, { statusCode: 401, message: 'x', code: 'not_found' });
        expect(res.writeHead).not.toHaveBeenCalled();
    });

    test('skips writeHead when headers already sent', () => {
        const res = makeRes();
        res.headersSent = true;
        sendPotluckError(res, { statusCode: 401, message: 'x', code: 'not_found' });
        expect(res.writeHead).not.toHaveBeenCalled();
        expect(res.end).toHaveBeenCalled();
    });

    test('logs error when res.end throws', () => {
        const res = makeRes();
        res.end.mockImplementation(() => { throw new Error('write fail'); });
        sendPotluckError(res, { statusCode: 401, message: 'x', code: 'not_found' });
        expect(mockLogger.error).toHaveBeenCalled();
    });
});
