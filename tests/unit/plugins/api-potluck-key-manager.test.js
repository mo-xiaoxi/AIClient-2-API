/**
 * Unit tests for plugins/api-potluck/key-manager.js
 *
 * Tests: createKey, listKeys, getKey, deleteKey, updateKeyLimit,
 *        resetKeyUsage, toggleKey, updateKeyName, validateKey,
 *        incrementUsage, getStats, setConfigGetter, getAllKeyIds,
 *        applyDailyLimitToAllKeys, regenerateKey
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const KEY_PREFIX_CONST = 'maki_';

// In-memory store shared across mock calls (simulates fs with no real files)
let mockFileStore = null;

let mockLogger;
let mockFsExistsSync;
let mockFsReadFileSync;
let mockFsWriteFileSync;
let mockFsPromisesWriteFile;
let mockFsPromisesRename;
let mockFsPromisesMkdir;

let createKey;
let listKeys;
let getKey;
let deleteKey;
let updateKeyLimit;
let resetKeyUsage;
let toggleKey;
let updateKeyName;
let validateKey;
let incrementUsage;
let getStats;
let setConfigGetter;
let getAllKeyIds;
let applyDailyLimitToAllKeys;
let regenerateKey;
let KEY_PREFIX;

beforeAll(async () => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    mockFsExistsSync = jest.fn();
    mockFsReadFileSync = jest.fn();
    mockFsWriteFileSync = jest.fn();
    mockFsPromisesWriteFile = jest.fn().mockResolvedValue(undefined);
    mockFsPromisesRename = jest.fn().mockResolvedValue(undefined);
    mockFsPromisesMkdir = jest.fn().mockResolvedValue(undefined);

    // Default: file does not exist -> fresh store
    mockFsExistsSync.mockReturnValue(false);

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: mockLogger,
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        promises: {
            writeFile: mockFsPromisesWriteFile,
            rename: mockFsPromisesRename,
            mkdir: mockFsPromisesMkdir,
        },
        existsSync: mockFsExistsSync,
        readFileSync: mockFsReadFileSync,
        writeFileSync: mockFsWriteFileSync,
    }));

    const mod = await import('../../../src/plugins/api-potluck/key-manager.js');
    createKey = mod.createKey;
    listKeys = mod.listKeys;
    getKey = mod.getKey;
    deleteKey = mod.deleteKey;
    updateKeyLimit = mod.updateKeyLimit;
    resetKeyUsage = mod.resetKeyUsage;
    toggleKey = mod.toggleKey;
    updateKeyName = mod.updateKeyName;
    validateKey = mod.validateKey;
    incrementUsage = mod.incrementUsage;
    getStats = mod.getStats;
    setConfigGetter = mod.setConfigGetter;
    getAllKeyIds = mod.getAllKeyIds;
    applyDailyLimitToAllKeys = mod.applyDailyLimitToAllKeys;
    regenerateKey = mod.regenerateKey;
    KEY_PREFIX = mod.KEY_PREFIX;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockFsExistsSync.mockReturnValue(false);
    mockFsPromisesWriteFile.mockResolvedValue(undefined);
    mockFsPromisesRename.mockResolvedValue(undefined);
    mockFsPromisesMkdir.mockResolvedValue(undefined);
});

// =============================================================================
// Constants
// =============================================================================

describe('KEY_PREFIX', () => {
    test('equals maki_', () => {
        expect(KEY_PREFIX).toBe(KEY_PREFIX_CONST);
    });
});

// =============================================================================
// setConfigGetter
// =============================================================================

describe('setConfigGetter()', () => {
    test('can be called without throwing', () => {
        expect(() => setConfigGetter(() => ({ defaultDailyLimit: 100, persistInterval: 5000 }))).not.toThrow();
    });

    test('accepts null to reset config getter', () => {
        expect(() => setConfigGetter(null)).not.toThrow();
    });
});

// =============================================================================
// createKey
// =============================================================================

describe('createKey()', () => {
    test('creates a key with default name when no name provided', async () => {
        const keyData = await createKey();
        expect(keyData).toBeDefined();
        expect(keyData.id).toMatch(new RegExp(`^${KEY_PREFIX_CONST}`));
        expect(keyData.enabled).toBe(true);
        expect(typeof keyData.dailyLimit).toBe('number');
    });

    test('creates a key with the given name', async () => {
        const keyData = await createKey('my-test-key');
        expect(keyData.name).toBe('my-test-key');
    });

    test('creates a key with specified dailyLimit', async () => {
        const keyData = await createKey('limit-key', 42);
        expect(keyData.dailyLimit).toBe(42);
    });

    test('sets todayUsage to 0 on creation', async () => {
        const keyData = await createKey('fresh-key');
        expect(keyData.todayUsage).toBe(0);
    });

    test('sets totalUsage to 0 on creation', async () => {
        const keyData = await createKey('fresh-key-2');
        expect(keyData.totalUsage).toBe(0);
    });

    test('sets lastUsedAt to null on creation', async () => {
        const keyData = await createKey('fresh-key-3');
        expect(keyData.lastUsedAt).toBeNull();
    });

    test('key id starts with KEY_PREFIX', async () => {
        const keyData = await createKey('prefix-check');
        expect(keyData.id.startsWith(KEY_PREFIX_CONST)).toBe(true);
    });
});

// =============================================================================
// listKeys
// =============================================================================

describe('listKeys()', () => {
    test('returns an array', async () => {
        const keys = await listKeys();
        expect(Array.isArray(keys)).toBe(true);
    });

    test('returns created keys in the list', async () => {
        const created = await createKey('listed-key');
        const keys = await listKeys();
        const found = keys.find(k => k.id === created.id);
        expect(found).toBeDefined();
    });

    test('each key entry includes maskedKey', async () => {
        await createKey('mask-test');
        const keys = await listKeys();
        expect(keys.every(k => typeof k.maskedKey === 'string')).toBe(true);
    });
});

// =============================================================================
// getKey
// =============================================================================

describe('getKey()', () => {
    test('returns null for non-existent key', async () => {
        const result = await getKey('maki_doesnotexist');
        expect(result).toBeNull();
    });

    test('returns key data for existing key', async () => {
        const created = await createKey('get-key-test');
        const result = await getKey(created.id);
        expect(result).toBeDefined();
        expect(result.id).toBe(created.id);
    });
});

// =============================================================================
// deleteKey
// =============================================================================

describe('deleteKey()', () => {
    test('returns false for non-existent key', async () => {
        const result = await deleteKey('maki_nonexistent');
        expect(result).toBe(false);
    });

    test('returns true and removes existing key', async () => {
        const created = await createKey('delete-me');
        const deleted = await deleteKey(created.id);
        expect(deleted).toBe(true);
        const after = await getKey(created.id);
        expect(after).toBeNull();
    });
});

// =============================================================================
// updateKeyLimit
// =============================================================================

describe('updateKeyLimit()', () => {
    test('returns null for non-existent key', async () => {
        const result = await updateKeyLimit('maki_ghost', 100);
        expect(result).toBeNull();
    });

    test('updates dailyLimit for existing key', async () => {
        const created = await createKey('limit-update-test', 100);
        await updateKeyLimit(created.id, 999);
        const updated = await getKey(created.id);
        expect(updated.dailyLimit).toBe(999);
    });
});

// =============================================================================
// resetKeyUsage
// =============================================================================

describe('resetKeyUsage()', () => {
    test('returns null for non-existent key', async () => {
        const result = await resetKeyUsage('maki_ghost');
        expect(result).toBeNull();
    });

    test('resets todayUsage to 0', async () => {
        const created = await createKey('reset-test', 500);
        // Manually increment usage
        await incrementUsage(created.id);
        await resetKeyUsage(created.id);
        const after = await getKey(created.id);
        expect(after.todayUsage).toBe(0);
    });
});

// =============================================================================
// toggleKey
// =============================================================================

describe('toggleKey()', () => {
    test('returns null for non-existent key', async () => {
        const result = await toggleKey('maki_ghost');
        expect(result).toBeNull();
    });

    test('disables an enabled key', async () => {
        const created = await createKey('toggle-test');
        expect(created.enabled).toBe(true);
        await toggleKey(created.id);
        const after = await getKey(created.id);
        expect(after.enabled).toBe(false);
    });

    test('re-enables a disabled key', async () => {
        const created = await createKey('toggle-back-test');
        await toggleKey(created.id); // disable
        await toggleKey(created.id); // re-enable
        const after = await getKey(created.id);
        expect(after.enabled).toBe(true);
    });
});

// =============================================================================
// updateKeyName
// =============================================================================

describe('updateKeyName()', () => {
    test('returns null for non-existent key', async () => {
        const result = await updateKeyName('maki_ghost', 'new-name');
        expect(result).toBeNull();
    });

    test('updates the name of an existing key', async () => {
        const created = await createKey('old-name');
        await updateKeyName(created.id, 'new-name');
        const after = await getKey(created.id);
        expect(after.name).toBe('new-name');
    });
});

// =============================================================================
// validateKey
// =============================================================================

describe('validateKey()', () => {
    test('returns invalid_format for key without KEY_PREFIX', async () => {
        const result = await validateKey('sk-notapotluckkey');
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('invalid_format');
    });

    test('returns invalid_format for null key', async () => {
        const result = await validateKey(null);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('invalid_format');
    });

    test('returns not_found for unknown potluck key', async () => {
        const result = await validateKey(`${KEY_PREFIX_CONST}unknownkey1234567890`);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('not_found');
    });

    test('returns valid: true for an enabled key with quota', async () => {
        const created = await createKey('valid-key-test', 500);
        const result = await validateKey(created.id);
        expect(result.valid).toBe(true);
        expect(result.keyData).toBeDefined();
    });

    test('returns disabled for a disabled key', async () => {
        const created = await createKey('disabled-key-test', 500);
        await toggleKey(created.id); // disable
        const result = await validateKey(created.id);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('disabled');
    });

    test('returns quota_exceeded when todayUsage >= dailyLimit', async () => {
        const created = await createKey('quota-test', 1);
        // Use up the quota
        await incrementUsage(created.id);
        const result = await validateKey(created.id);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('quota_exceeded');
    });
});

// =============================================================================
// incrementUsage
// =============================================================================

describe('incrementUsage()', () => {
    test('returns null for non-existent key', async () => {
        const result = await incrementUsage('maki_doesnotexist');
        expect(result).toBeNull();
    });

    test('increments todayUsage and totalUsage', async () => {
        const created = await createKey('usage-increment', 500);
        await incrementUsage(created.id, 'gemini', 'gemini-pro');
        const after = await getKey(created.id);
        expect(after.todayUsage).toBe(1);
        expect(after.totalUsage).toBe(1);
    });

    test('sets lastUsedAt to an ISO string', async () => {
        const created = await createKey('lastusedat-test', 500);
        await incrementUsage(created.id);
        const after = await getKey(created.id);
        expect(typeof after.lastUsedAt).toBe('string');
        expect(() => new Date(after.lastUsedAt)).not.toThrow();
    });

    test('records provider and model in usageHistory', async () => {
        const created = await createKey('history-test', 500);
        await incrementUsage(created.id, 'openai', 'gpt-4');
        const after = await getKey(created.id);
        const today = Object.keys(after.usageHistory)[0];
        expect(after.usageHistory[today].providers['openai']).toBe(1);
        expect(after.usageHistory[today].models['gpt-4']).toBe(1);
    });

    test('returns null when quota is already exhausted', async () => {
        const created = await createKey('exhausted-quota', 1);
        await incrementUsage(created.id); // use up the 1 quota
        const result = await incrementUsage(created.id); // should be null
        expect(result).toBeNull();
    });

    test('handles missing provider/model gracefully', async () => {
        const created = await createKey('default-provider-test', 500);
        const result = await incrementUsage(created.id, null, null);
        expect(result).not.toBeNull();
        const after = await getKey(created.id);
        const today = Object.keys(after.usageHistory)[0];
        expect(after.usageHistory[today].providers['unknown']).toBe(1);
        expect(after.usageHistory[today].models['unknown']).toBe(1);
    });
});

// =============================================================================
// getStats
// =============================================================================

describe('getStats()', () => {
    test('returns stats object with expected fields', async () => {
        const stats = await getStats();
        expect(typeof stats.totalKeys).toBe('number');
        expect(typeof stats.enabledKeys).toBe('number');
        expect(typeof stats.disabledKeys).toBe('number');
        expect(typeof stats.todayTotalUsage).toBe('number');
        expect(typeof stats.totalUsage).toBe('number');
        expect(typeof stats.usageHistory).toBe('object');
    });

    test('counts enabled and disabled keys correctly', async () => {
        const k1 = await createKey('stats-enabled', 500);
        const k2 = await createKey('stats-disabled', 500);
        await toggleKey(k2.id); // disable k2

        const stats = await getStats();
        // Just verify the counts are sane (other tests may have added keys too)
        expect(stats.enabledKeys).toBeGreaterThanOrEqual(1);
        expect(stats.disabledKeys).toBeGreaterThanOrEqual(1);
        expect(stats.totalKeys).toBe(stats.enabledKeys + stats.disabledKeys);
    });

    test('aggregates usageHistory across keys', async () => {
        const k = await createKey('history-agg-test', 500);
        await incrementUsage(k.id, 'gemini', 'gemini-flash');
        const stats = await getStats();
        // Should have at least one date entry
        const dates = Object.keys(stats.usageHistory);
        expect(dates.length).toBeGreaterThan(0);
    });
});

// =============================================================================
// getAllKeyIds
// =============================================================================

describe('getAllKeyIds()', () => {
    test('returns an array of key id strings', () => {
        const ids = getAllKeyIds();
        expect(Array.isArray(ids)).toBe(true);
    });

    test('includes a created key id', async () => {
        const created = await createKey('getallkeys-test');
        const ids = getAllKeyIds();
        expect(ids).toContain(created.id);
    });
});

// =============================================================================
// applyDailyLimitToAllKeys
// =============================================================================

describe('applyDailyLimitToAllKeys()', () => {
    test('updates all keys to the new limit', async () => {
        const k1 = await createKey('apply-limit-1', 100);
        const k2 = await createKey('apply-limit-2', 200);
        await applyDailyLimitToAllKeys(999);
        const a1 = await getKey(k1.id);
        const a2 = await getKey(k2.id);
        expect(a1.dailyLimit).toBe(999);
        expect(a2.dailyLimit).toBe(999);
    });

    test('returns total and updated counts', async () => {
        await createKey('apply-count-test', 50);
        const result = await applyDailyLimitToAllKeys(50); // same value won't update
        expect(typeof result.total).toBe('number');
        expect(typeof result.updated).toBe('number');
    });
});

// =============================================================================
// regenerateKey
// =============================================================================

describe('regenerateKey()', () => {
    test('returns null for non-existent key', async () => {
        const result = await regenerateKey('maki_ghost123456');
        expect(result).toBeNull();
    });

    test('returns oldKey, newKey and keyData for existing key', async () => {
        const created = await createKey('regen-test');
        const result = await regenerateKey(created.id);
        expect(result).not.toBeNull();
        expect(result.oldKey).toBe(created.id);
        expect(result.newKey).toMatch(new RegExp(`^${KEY_PREFIX_CONST}`));
        expect(result.newKey).not.toBe(created.id);
        expect(result.keyData).toBeDefined();
    });

    test('removes the old key after regeneration', async () => {
        const created = await createKey('regen-delete-old');
        const result = await regenerateKey(created.id);
        const old = await getKey(created.id);
        expect(old).toBeNull();
    });

    test('new key retains the original key name', async () => {
        const created = await createKey('regen-name-test');
        const result = await regenerateKey(created.id);
        expect(result.keyData.name).toBe('regen-name-test');
    });
});
