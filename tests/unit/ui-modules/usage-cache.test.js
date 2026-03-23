/**
 * Unit tests for src/ui-modules/usage-cache.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks - must be declared before imports
// ---------------------------------------------------------------------------

const mockExistsSync = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();

jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: mockExistsSync,
        promises: {
            readFile: mockReadFile,
            writeFile: mockWriteFile,
        },
    };
});

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
let readUsageCache;
let writeUsageCache;
let readProviderUsageCache;
let updateProviderUsageCache;

beforeAll(async () => {
    ({
        readUsageCache,
        writeUsageCache,
        readProviderUsageCache,
        updateProviderUsageCache,
    } = await import('../../../src/ui-modules/usage-cache.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// readUsageCache
// ---------------------------------------------------------------------------
describe('readUsageCache', () => {
    test('returns null when cache file does not exist', async () => {
        mockExistsSync.mockReturnValue(false);

        const result = await readUsageCache();

        expect(result).toBeNull();
        expect(mockReadFile).not.toHaveBeenCalled();
    });

    test('returns parsed JSON when cache file exists', async () => {
        const cacheData = { timestamp: '2024-01-01T00:00:00.000Z', providers: { gemini: { total: 100 } } };
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify(cacheData));

        const result = await readUsageCache();

        expect(result).toEqual(cacheData);
    });

    test('returns null when file read fails', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockRejectedValue(new Error('read error'));

        const result = await readUsageCache();

        expect(result).toBeNull();
    });

    test('returns null when file content is invalid JSON', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue('not valid json {{{');

        const result = await readUsageCache();

        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// writeUsageCache
// ---------------------------------------------------------------------------
describe('writeUsageCache', () => {
    test('writes JSON data to file', async () => {
        mockWriteFile.mockResolvedValue(undefined);
        const usageData = { timestamp: '2024-01-01T00:00:00.000Z', providers: {} };

        await writeUsageCache(usageData);

        expect(mockWriteFile).toHaveBeenCalledWith(
            expect.stringContaining('usage-cache.json'),
            JSON.stringify(usageData, null, 2),
            'utf8'
        );
    });

    test('does not throw when write fails (logs error)', async () => {
        mockWriteFile.mockRejectedValue(new Error('disk full'));

        await expect(writeUsageCache({ providers: {} })).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// readProviderUsageCache
// ---------------------------------------------------------------------------
describe('readProviderUsageCache', () => {
    test('returns null when cache is null', async () => {
        mockExistsSync.mockReturnValue(false);

        const result = await readProviderUsageCache('gemini');

        expect(result).toBeNull();
    });

    test('returns null when provider type not in cache', async () => {
        const cacheData = { timestamp: '2024-01-01T00:00:00.000Z', providers: { other: {} } };
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify(cacheData));

        const result = await readProviderUsageCache('gemini');

        expect(result).toBeNull();
    });

    test('returns provider data with cache metadata when found', async () => {
        const providerData = { totalTokens: 500, requests: 10 };
        const cacheData = {
            timestamp: '2024-01-01T00:00:00.000Z',
            providers: { 'gemini-cli-oauth': providerData }
        };
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify(cacheData));

        const result = await readProviderUsageCache('gemini-cli-oauth');

        expect(result).toMatchObject({
            ...providerData,
            cachedAt: cacheData.timestamp,
            fromCache: true,
        });
    });
});

// ---------------------------------------------------------------------------
// updateProviderUsageCache
// ---------------------------------------------------------------------------
describe('updateProviderUsageCache', () => {
    test('creates new cache structure when none exists', async () => {
        mockExistsSync.mockReturnValue(false);
        mockWriteFile.mockResolvedValue(undefined);

        await updateProviderUsageCache('gemini', { total: 42 });

        const written = mockWriteFile.mock.calls[0][1];
        const parsed = JSON.parse(written);
        expect(parsed.providers['gemini']).toEqual({ total: 42 });
        expect(parsed.timestamp).toBeDefined();
    });

    test('merges into existing cache', async () => {
        const existingCache = {
            timestamp: '2024-01-01T00:00:00.000Z',
            providers: { 'other-provider': { total: 10 } }
        };
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify(existingCache));
        mockWriteFile.mockResolvedValue(undefined);

        await updateProviderUsageCache('gemini', { total: 42 });

        const written = mockWriteFile.mock.calls[0][1];
        const parsed = JSON.parse(written);
        expect(parsed.providers['other-provider']).toEqual({ total: 10 });
        expect(parsed.providers['gemini']).toEqual({ total: 42 });
    });

    test('overwrites existing provider data', async () => {
        const existingCache = {
            timestamp: '2024-01-01T00:00:00.000Z',
            providers: { 'gemini': { total: 10 } }
        };
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify(existingCache));
        mockWriteFile.mockResolvedValue(undefined);

        await updateProviderUsageCache('gemini', { total: 99 });

        const written = mockWriteFile.mock.calls[0][1];
        const parsed = JSON.parse(written);
        expect(parsed.providers['gemini']).toEqual({ total: 99 });
    });
});
