/**
 * Unit tests for plugins/api-potluck/api-routes.js
 *
 * Tests: handlePotluckApiRoutes(), handlePotluckUserApiRoutes()
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const KEY_PREFIX = 'maki_';
const VALID_KEY = `${KEY_PREFIX}routetestkey12345`;

let handlePotluckApiRoutes;
let handlePotluckUserApiRoutes;

let mockCreateKey;
let mockListKeys;
let mockGetKey;
let mockDeleteKey;
let mockUpdateKeyLimit;
let mockResetKeyUsage;
let mockToggleKey;
let mockUpdateKeyName;
let mockRegenerateKey;
let mockGetStats;
let mockValidateKey;
let mockApplyDailyLimitToAllKeys;
let mockGetAllKeyIds;
let mockLogger;

// Helper: simulate a request body via readable stream events
function makeBodyReq(headers = {}, bodyObj = {}) {
    const bodyStr = JSON.stringify(bodyObj);
    const listeners = {};
    return {
        headers,
        on(event, cb) {
            listeners[event] = cb;
            return this;
        },
        _emit(event, data) {
            if (listeners[event]) listeners[event](data);
        },
        _end() {
            if (listeners['data']) listeners['data'](Buffer.from(bodyStr));
            if (listeners['end']) listeners['end']();
        },
    };
}

function makeRes() {
    const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
        writableEnded: false,
        destroyed: false,
        headersSent: false,
    };
    return res;
}

function parseSentJson(res) {
    const raw = res.end.mock.calls[0][0];
    return JSON.parse(raw);
}

// Build a minimal token store file content for admin auth
const VALID_ADMIN_TOKEN = 'admin-token-xyz';
const TOKEN_STORE_CONTENT = JSON.stringify({
    tokens: {
        [VALID_ADMIN_TOKEN]: {
            expiryTime: Date.now() + 3600 * 1000, // 1 hour from now
        },
    },
});

beforeAll(async () => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    mockCreateKey = jest.fn();
    mockListKeys = jest.fn();
    mockGetKey = jest.fn();
    mockDeleteKey = jest.fn();
    mockUpdateKeyLimit = jest.fn();
    mockResetKeyUsage = jest.fn();
    mockToggleKey = jest.fn();
    mockUpdateKeyName = jest.fn();
    mockRegenerateKey = jest.fn();
    mockGetStats = jest.fn();
    mockValidateKey = jest.fn();
    mockApplyDailyLimitToAllKeys = jest.fn();
    mockGetAllKeyIds = jest.fn().mockReturnValue([]);

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: mockLogger,
    }));

    await jest.unstable_mockModule('../../../src/plugins/api-potluck/key-manager.js', () => ({
        __esModule: true,
        KEY_PREFIX,
        createKey: mockCreateKey,
        listKeys: mockListKeys,
        getKey: mockGetKey,
        deleteKey: mockDeleteKey,
        updateKeyLimit: mockUpdateKeyLimit,
        resetKeyUsage: mockResetKeyUsage,
        toggleKey: mockToggleKey,
        updateKeyName: mockUpdateKeyName,
        regenerateKey: mockRegenerateKey,
        getStats: mockGetStats,
        validateKey: mockValidateKey,
        applyDailyLimitToAllKeys: mockApplyDailyLimitToAllKeys,
        getAllKeyIds: mockGetAllKeyIds,
        setConfigGetter: jest.fn(),
    }));

    // Mock the fs module used inside checkAdminAuth
    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        existsSync: jest.fn().mockReturnValue(true),
        readFileSync: jest.fn().mockReturnValue(TOKEN_STORE_CONTENT),
        writeFileSync: jest.fn(),
        promises: {
            writeFile: jest.fn().mockResolvedValue(undefined),
            rename: jest.fn().mockResolvedValue(undefined),
            mkdir: jest.fn().mockResolvedValue(undefined),
        },
    }));

    const mod = await import('../../../src/plugins/api-potluck/api-routes.js');
    handlePotluckApiRoutes = mod.handlePotluckApiRoutes;
    handlePotluckUserApiRoutes = mod.handlePotluckUserApiRoutes;
});

beforeEach(() => {
    jest.clearAllMocks();
    // Restore fs mocks to default (token store exists and valid)
    const fsMod = jest.getMockImplementation
        ? undefined
        : undefined;
});

// =============================================================================
// handlePotluckApiRoutes — path guard
// =============================================================================

describe('handlePotluckApiRoutes() - path guard', () => {
    test('returns false for paths not starting with /api/potluck', async () => {
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        const result = await handlePotluckApiRoutes('GET', '/other/path', req, res);
        expect(result).toBe(false);
    });
});

// =============================================================================
// handlePotluckApiRoutes — auth guard
// =============================================================================

describe('handlePotluckApiRoutes() - auth guard', () => {
    test('returns 401 when no authorization header', async () => {
        const req = makeBodyReq({});
        const res = makeRes();
        await handlePotluckApiRoutes('GET', '/api/potluck/stats', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('UNAUTHORIZED');
    });

    test('returns 401 when authorization header format is wrong (no Bearer)', async () => {
        const req = makeBodyReq({ authorization: 'Basic sometoken' });
        const res = makeRes();
        await handlePotluckApiRoutes('GET', '/api/potluck/stats', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });
});

// =============================================================================
// handlePotluckApiRoutes — GET /api/potluck/stats (authed)
// =============================================================================

describe('handlePotluckApiRoutes() - GET /api/potluck/stats', () => {
    test('returns stats on success', async () => {
        const fakeStats = { totalKeys: 5, enabledKeys: 3 };
        mockGetStats.mockResolvedValue(fakeStats);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        const result = await handlePotluckApiRoutes('GET', '/api/potluck/stats', req, res);
        expect(result).toBe(true);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
        expect(body.data).toEqual(fakeStats);
    });
});

// =============================================================================
// handlePotluckApiRoutes — GET /api/potluck/keys
// =============================================================================

describe('handlePotluckApiRoutes() - GET /api/potluck/keys', () => {
    test('returns keys and stats', async () => {
        mockListKeys.mockResolvedValue([{ id: VALID_KEY, name: 'test' }]);
        mockGetStats.mockResolvedValue({ totalKeys: 1 });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('GET', '/api/potluck/keys', req, res);
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
        expect(body.data.keys).toHaveLength(1);
        expect(body.data.stats).toBeDefined();
    });
});

// =============================================================================
// handlePotluckApiRoutes — POST /api/potluck/keys
// =============================================================================

describe('handlePotluckApiRoutes() - POST /api/potluck/keys', () => {
    test('creates key and returns 201', async () => {
        const keyData = { id: VALID_KEY, name: 'new-key' };
        mockCreateKey.mockResolvedValue(keyData);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { name: 'new-key', dailyLimit: 100 });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('POST', '/api/potluck/keys', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
        expect(body.data).toEqual(keyData);
    });
});

// =============================================================================
// handlePotluckApiRoutes — POST /api/potluck/keys/apply-limit
// =============================================================================

describe('handlePotluckApiRoutes() - POST /api/potluck/keys/apply-limit', () => {
    test('returns 400 when dailyLimit is missing', async () => {
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, {});
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('POST', '/api/potluck/keys/apply-limit', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 400 when dailyLimit is zero or negative', async () => {
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { dailyLimit: 0 });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('POST', '/api/potluck/keys/apply-limit', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('applies limit and returns 200 when dailyLimit is valid', async () => {
        mockApplyDailyLimitToAllKeys.mockResolvedValue({ total: 3, updated: 3 });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { dailyLimit: 100 });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('POST', '/api/potluck/keys/apply-limit', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
    });
});

// =============================================================================
// handlePotluckApiRoutes — GET /api/potluck/keys/:keyId
// =============================================================================

describe('handlePotluckApiRoutes() - GET /api/potluck/keys/:keyId', () => {
    test('returns 404 when key not found', async () => {
        mockGetKey.mockResolvedValue(null);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('GET', `/api/potluck/keys/${VALID_KEY}`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 with key data when found', async () => {
        const keyData = { id: VALID_KEY, name: 'found-key' };
        mockGetKey.mockResolvedValue(keyData);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('GET', `/api/potluck/keys/${VALID_KEY}`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
        expect(body.data).toEqual(keyData);
    });
});

// =============================================================================
// handlePotluckApiRoutes — DELETE /api/potluck/keys/:keyId
// =============================================================================

describe('handlePotluckApiRoutes() - DELETE /api/potluck/keys/:keyId', () => {
    test('returns 404 when key does not exist', async () => {
        mockDeleteKey.mockResolvedValue(false);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('DELETE', `/api/potluck/keys/${VALID_KEY}`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 on successful deletion', async () => {
        mockDeleteKey.mockResolvedValue(true);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('DELETE', `/api/potluck/keys/${VALID_KEY}`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
    });
});

// =============================================================================
// handlePotluckApiRoutes — PUT /api/potluck/keys/:keyId/limit
// =============================================================================

describe('handlePotluckApiRoutes() - PUT /api/potluck/keys/:keyId/limit', () => {
    test('returns 400 for invalid dailyLimit', async () => {
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { dailyLimit: -1 });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('PUT', `/api/potluck/keys/${VALID_KEY}/limit`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 404 when key not found', async () => {
        mockUpdateKeyLimit.mockResolvedValue(null);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { dailyLimit: 100 });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('PUT', `/api/potluck/keys/${VALID_KEY}/limit`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 on success', async () => {
        mockUpdateKeyLimit.mockResolvedValue({ id: VALID_KEY, dailyLimit: 100 });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { dailyLimit: 100 });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('PUT', `/api/potluck/keys/${VALID_KEY}/limit`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });
});

// =============================================================================
// handlePotluckApiRoutes — POST /api/potluck/keys/:keyId/reset
// =============================================================================

describe('handlePotluckApiRoutes() - POST /api/potluck/keys/:keyId/reset', () => {
    test('returns 404 when key not found', async () => {
        mockResetKeyUsage.mockResolvedValue(null);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('POST', `/api/potluck/keys/${VALID_KEY}/reset`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 on success', async () => {
        mockResetKeyUsage.mockResolvedValue({ id: VALID_KEY, todayUsage: 0 });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('POST', `/api/potluck/keys/${VALID_KEY}/reset`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });
});

// =============================================================================
// handlePotluckApiRoutes — POST /api/potluck/keys/:keyId/toggle
// =============================================================================

describe('handlePotluckApiRoutes() - POST /api/potluck/keys/:keyId/toggle', () => {
    test('returns 404 when key not found', async () => {
        mockToggleKey.mockResolvedValue(null);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('POST', `/api/potluck/keys/${VALID_KEY}/toggle`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 with enabled status', async () => {
        mockToggleKey.mockResolvedValue({ id: VALID_KEY, enabled: true });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('POST', `/api/potluck/keys/${VALID_KEY}/toggle`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
    });
});

// =============================================================================
// handlePotluckApiRoutes — PUT /api/potluck/keys/:keyId/name
// =============================================================================

describe('handlePotluckApiRoutes() - PUT /api/potluck/keys/:keyId/name', () => {
    test('returns 400 when name is missing or empty', async () => {
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { name: '' });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('PUT', `/api/potluck/keys/${VALID_KEY}/name`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 404 when key not found', async () => {
        mockUpdateKeyName.mockResolvedValue(null);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { name: 'new-name' });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('PUT', `/api/potluck/keys/${VALID_KEY}/name`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 on success', async () => {
        mockUpdateKeyName.mockResolvedValue({ id: VALID_KEY, name: 'new-name' });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` }, { name: 'new-name' });
        req._end();
        const res = makeRes();
        await handlePotluckApiRoutes('PUT', `/api/potluck/keys/${VALID_KEY}/name`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });
});

// =============================================================================
// handlePotluckApiRoutes — POST /api/potluck/keys/:keyId/regenerate
// =============================================================================

describe('handlePotluckApiRoutes() - POST /api/potluck/keys/:keyId/regenerate', () => {
    test('returns 404 when key not found', async () => {
        mockRegenerateKey.mockResolvedValue(null);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('POST', `/api/potluck/keys/${VALID_KEY}/regenerate`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 with new key data', async () => {
        const newKey = `${KEY_PREFIX}newkey1234567890`;
        mockRegenerateKey.mockResolvedValue({
            oldKey: VALID_KEY,
            newKey,
            keyData: { id: newKey, name: 'regen-key' },
        });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('POST', `/api/potluck/keys/${VALID_KEY}/regenerate`, req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
        expect(body.data.oldKey).toBe(VALID_KEY);
        expect(body.data.newKey).toBe(newKey);
    });
});

// =============================================================================
// handlePotluckApiRoutes — unmatched potluck route
// =============================================================================

describe('handlePotluckApiRoutes() - unmatched route', () => {
    test('returns 404 for unknown /api/potluck/* path', async () => {
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('GET', '/api/potluck/unknown-endpoint', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
});

// =============================================================================
// handlePotluckApiRoutes — error handling
// =============================================================================

describe('handlePotluckApiRoutes() - error handling', () => {
    test('returns 500 on unexpected error', async () => {
        mockGetStats.mockRejectedValue(new Error('DB error'));
        const req = makeBodyReq({ authorization: `Bearer ${VALID_ADMIN_TOKEN}` });
        const res = makeRes();
        await handlePotluckApiRoutes('GET', '/api/potluck/stats', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});

// =============================================================================
// handlePotluckUserApiRoutes — path guard
// =============================================================================

describe('handlePotluckUserApiRoutes() - path guard', () => {
    test('returns false for paths not starting with /api/potluckuser', async () => {
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        const result = await handlePotluckUserApiRoutes('GET', '/other/path', req, res);
        expect(result).toBe(false);
    });
});

// =============================================================================
// handlePotluckUserApiRoutes — auth
// =============================================================================

describe('handlePotluckUserApiRoutes() - auth', () => {
    test('returns 401 when no API key provided', async () => {
        const req = makeBodyReq({});
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.error.code).toBe('API_KEY_REQUIRED');
    });

    test('returns 401 for invalid API key format', async () => {
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'invalid_format' });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });

    test('returns 401 for not_found key', async () => {
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'not_found' });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });

    test('returns 401 for disabled key', async () => {
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'disabled' });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });
});

// =============================================================================
// handlePotluckUserApiRoutes — GET /api/potluckuser/usage
// =============================================================================

describe('handlePotluckUserApiRoutes() - GET /api/potluckuser/usage', () => {
    test('returns 404 when getKey returns null for valid key', async () => {
        // quota_exceeded reason is allowed through for user queries
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'quota_exceeded' });
        mockGetKey.mockResolvedValue(null);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 with usage data for valid quota-exceeded key', async () => {
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'quota_exceeded' });
        const keyData = {
            id: VALID_KEY,
            name: 'my-key',
            enabled: true,
            todayUsage: 100,
            dailyLimit: 100,
            lastResetDate: '2026-03-23',
            totalUsage: 500,
            lastUsedAt: '2026-03-23T10:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
            usageHistory: {},
        };
        mockGetKey.mockResolvedValue(keyData);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.success).toBe(true);
        expect(body.data.usage.today).toBe(100);
        expect(body.data.usage.limit).toBe(100);
        expect(body.data.usage.remaining).toBe(0);
        expect(body.data.usage.percent).toBe(100);
    });

    test('returns 200 with usage data for valid key', async () => {
        mockValidateKey.mockResolvedValue({ valid: true, keyData: { id: VALID_KEY } });
        const keyData = {
            id: VALID_KEY,
            name: 'active-key',
            enabled: true,
            todayUsage: 10,
            dailyLimit: 500,
            lastResetDate: '2026-03-23',
            totalUsage: 50,
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00Z',
            usageHistory: {},
        };
        mockGetKey.mockResolvedValue(keyData);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseSentJson(res);
        expect(body.data.usage.remaining).toBe(490);
        expect(body.data.maskedKey).toContain('...');
    });

    test('computes usagePercent as 0 when dailyLimit is 0', async () => {
        mockValidateKey.mockResolvedValue({ valid: true, keyData: { id: VALID_KEY } });
        const keyData = {
            id: VALID_KEY, name: 'zero-limit', enabled: true,
            todayUsage: 0, dailyLimit: 0, lastResetDate: '2026-03-23',
            totalUsage: 0, lastUsedAt: null, createdAt: '2026-01-01T00:00:00Z', usageHistory: {},
        };
        mockGetKey.mockResolvedValue(keyData);
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        const body = parseSentJson(res);
        expect(body.data.usage.percent).toBe(0);
    });
});

// =============================================================================
// handlePotluckUserApiRoutes — unmatched route
// =============================================================================

describe('handlePotluckUserApiRoutes() - unmatched route', () => {
    test('returns 404 for unknown /api/potluckuser/* path', async () => {
        mockValidateKey.mockResolvedValue({ valid: true, keyData: { id: VALID_KEY } });
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/unknown', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
});

// =============================================================================
// handlePotluckUserApiRoutes — error handling
// =============================================================================

describe('handlePotluckUserApiRoutes() - error handling', () => {
    test('returns 500 on unexpected error', async () => {
        mockValidateKey.mockRejectedValue(new Error('DB error'));
        const req = makeBodyReq({ authorization: `Bearer ${VALID_KEY}` });
        const res = makeRes();
        await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});
