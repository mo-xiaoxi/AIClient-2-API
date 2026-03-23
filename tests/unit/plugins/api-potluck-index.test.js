/**
 * Unit tests for plugins/api-potluck/index.js
 *
 * Tests: plugin metadata, authenticate(), hooks.onContentGenerated()
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const KEY_PREFIX = 'maki_';
const VALID_KEY = `${KEY_PREFIX}abc123def456abc1`;

let apiPotluckPlugin;

let mockValidateKey;
let mockIncrementUsage;
let mockExtractPotluckKey;
let mockSendPotluckError;
let mockLogger;

beforeAll(async () => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    mockValidateKey = jest.fn();
    mockIncrementUsage = jest.fn().mockResolvedValue({});
    mockExtractPotluckKey = jest.fn();
    mockSendPotluckError = jest.fn();

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: mockLogger,
    }));

    await jest.unstable_mockModule('../../../src/plugins/api-potluck/key-manager.js', () => ({
        __esModule: true,
        KEY_PREFIX,
        validateKey: mockValidateKey,
        incrementUsage: mockIncrementUsage,
        createKey: jest.fn(),
        listKeys: jest.fn().mockResolvedValue([]),
        getKey: jest.fn(),
        deleteKey: jest.fn(),
        updateKeyLimit: jest.fn(),
        resetKeyUsage: jest.fn(),
        toggleKey: jest.fn(),
        updateKeyName: jest.fn(),
        getStats: jest.fn().mockResolvedValue({}),
        setConfigGetter: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../src/plugins/api-potluck/middleware.js', () => ({
        __esModule: true,
        extractPotluckKey: mockExtractPotluckKey,
        isPotluckRequest: jest.fn().mockReturnValue(false),
        sendPotluckError: mockSendPotluckError,
    }));

    await jest.unstable_mockModule('../../../src/plugins/api-potluck/api-routes.js', () => ({
        __esModule: true,
        handlePotluckApiRoutes: jest.fn().mockResolvedValue(true),
        handlePotluckUserApiRoutes: jest.fn().mockResolvedValue(true),
    }));

    const mod = await import('../../../src/plugins/api-potluck/index.js');
    apiPotluckPlugin = mod.default;
});

beforeEach(() => {
    jest.clearAllMocks();
});

// Helpers
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
// Plugin metadata
// =============================================================================

describe('apiPotluckPlugin metadata', () => {
    test('has correct name', () => {
        expect(apiPotluckPlugin.name).toBe('api-potluck');
    });

    test('has type auth', () => {
        expect(apiPotluckPlugin.type).toBe('auth');
    });

    test('has version string', () => {
        expect(typeof apiPotluckPlugin.version).toBe('string');
    });

    test('has description string', () => {
        expect(typeof apiPotluckPlugin.description).toBe('string');
    });

    test('has _priority number', () => {
        expect(typeof apiPotluckPlugin._priority).toBe('number');
    });

    test('has staticPaths array', () => {
        expect(Array.isArray(apiPotluckPlugin.staticPaths)).toBe(true);
        expect(apiPotluckPlugin.staticPaths.length).toBeGreaterThan(0);
    });

    test('has routes array with method and path', () => {
        expect(Array.isArray(apiPotluckPlugin.routes)).toBe(true);
        apiPotluckPlugin.routes.forEach(route => {
            expect(route).toHaveProperty('method');
            expect(route).toHaveProperty('path');
            expect(route).toHaveProperty('handler');
        });
    });

    test('has hooks object with onContentGenerated', () => {
        expect(typeof apiPotluckPlugin.hooks).toBe('object');
        expect(typeof apiPotluckPlugin.hooks.onContentGenerated).toBe('function');
    });

    test('has exports object', () => {
        expect(typeof apiPotluckPlugin.exports).toBe('object');
    });

    test('exports includes validateKey', () => {
        expect(typeof apiPotluckPlugin.exports.validateKey).toBe('function');
    });

    test('exports includes KEY_PREFIX', () => {
        expect(apiPotluckPlugin.exports.KEY_PREFIX).toBe(KEY_PREFIX);
    });
});

// =============================================================================
// init() and destroy()
// =============================================================================

describe('init() and destroy()', () => {
    test('init() resolves without throwing', async () => {
        await expect(apiPotluckPlugin.init({})).resolves.not.toThrow();
    });

    test('destroy() resolves without throwing', async () => {
        await expect(apiPotluckPlugin.destroy()).resolves.not.toThrow();
    });

    test('init() calls logger.info', async () => {
        await apiPotluckPlugin.init({});
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test('destroy() calls logger.info', async () => {
        await apiPotluckPlugin.destroy();
        expect(mockLogger.info).toHaveBeenCalled();
    });
});

// =============================================================================
// authenticate()
// =============================================================================

describe('authenticate()', () => {
    test('returns handled: false, authorized: null when no potluck key', async () => {
        mockExtractPotluckKey.mockReturnValue(null);
        const result = await apiPotluckPlugin.authenticate(makeReq(), makeRes(), makeUrl(), {});
        expect(result.handled).toBe(false);
        expect(result.authorized).toBeNull();
    });

    test('returns handled: false, authorized: true for valid key', async () => {
        mockExtractPotluckKey.mockReturnValue(VALID_KEY);
        mockValidateKey.mockResolvedValue({ valid: true, keyData: { id: VALID_KEY } });
        const result = await apiPotluckPlugin.authenticate(makeReq(), makeRes(), makeUrl(), {});
        expect(result.handled).toBe(false);
        expect(result.authorized).toBe(true);
        expect(result.data.potluckApiKey).toBe(VALID_KEY);
        expect(result.data.potluckKeyData).toBeDefined();
    });

    test('returns handled: true, authorized: false for invalid_format key', async () => {
        mockExtractPotluckKey.mockReturnValue(VALID_KEY);
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'invalid_format' });
        const res = makeRes();
        const result = await apiPotluckPlugin.authenticate(makeReq(), res, makeUrl(), {});
        expect(result.handled).toBe(true);
        expect(result.authorized).toBe(false);
        expect(result.error.statusCode).toBe(401);
        expect(mockSendPotluckError).toHaveBeenCalled();
    });

    test('returns 403 status for disabled key', async () => {
        mockExtractPotluckKey.mockReturnValue(VALID_KEY);
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'disabled' });
        const result = await apiPotluckPlugin.authenticate(makeReq(), makeRes(), makeUrl(), {});
        expect(result.error.statusCode).toBe(403);
    });

    test('returns 429 status for quota_exceeded', async () => {
        mockExtractPotluckKey.mockReturnValue(VALID_KEY);
        mockValidateKey.mockResolvedValue({
            valid: false,
            reason: 'quota_exceeded',
            keyData: { todayUsage: 500, dailyLimit: 500 },
        });
        const result = await apiPotluckPlugin.authenticate(makeReq(), makeRes(), makeUrl(), {});
        expect(result.error.statusCode).toBe(429);
    });

    test('returns 401 for not_found', async () => {
        mockExtractPotluckKey.mockReturnValue(VALID_KEY);
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'not_found' });
        const result = await apiPotluckPlugin.authenticate(makeReq(), makeRes(), makeUrl(), {});
        expect(result.error.statusCode).toBe(401);
    });

    test('defaults to 401 for unknown reason', async () => {
        mockExtractPotluckKey.mockReturnValue(VALID_KEY);
        mockValidateKey.mockResolvedValue({ valid: false, reason: 'some_unknown' });
        const result = await apiPotluckPlugin.authenticate(makeReq(), makeRes(), makeUrl(), {});
        expect(result.error.statusCode).toBe(401);
    });

    test('logs info on successful authentication', async () => {
        mockExtractPotluckKey.mockReturnValue(VALID_KEY);
        mockValidateKey.mockResolvedValue({ valid: true, keyData: { id: VALID_KEY } });
        await apiPotluckPlugin.authenticate(makeReq(), makeRes(), makeUrl(), {});
        expect(mockLogger.info).toHaveBeenCalled();
    });
});

// =============================================================================
// hooks.onContentGenerated()
// =============================================================================

describe('hooks.onContentGenerated()', () => {
    test('does nothing when potluckApiKey is absent', async () => {
        await expect(apiPotluckPlugin.hooks.onContentGenerated({})).resolves.not.toThrow();
        expect(mockIncrementUsage).not.toHaveBeenCalled();
    });

    test('calls incrementUsage when potluckApiKey is present', async () => {
        await apiPotluckPlugin.hooks.onContentGenerated({
            potluckApiKey: VALID_KEY,
            toProvider: 'openai',
            model: 'gpt-4',
        });
        expect(mockIncrementUsage).toHaveBeenCalledWith(VALID_KEY, 'openai', 'gpt-4');
    });

    test('silently logs error when incrementUsage throws', async () => {
        mockIncrementUsage.mockRejectedValue(new Error('increment error'));
        await expect(apiPotluckPlugin.hooks.onContentGenerated({
            potluckApiKey: VALID_KEY,
            toProvider: 'gemini',
            model: 'gemini-pro',
        })).resolves.not.toThrow();
        expect(mockLogger.error).toHaveBeenCalled();
    });

    test('passes undefined provider/model when not in context', async () => {
        mockIncrementUsage.mockResolvedValue({});
        await apiPotluckPlugin.hooks.onContentGenerated({
            potluckApiKey: VALID_KEY,
        });
        expect(mockIncrementUsage).toHaveBeenCalledWith(VALID_KEY, undefined, undefined);
    });
});
