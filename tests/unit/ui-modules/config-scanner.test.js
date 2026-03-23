/**
 * Unit tests for src/ui-modules/config-scanner.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExistsSync = jest.fn();
const mockReaddir = jest.fn();
const mockStat = jest.fn();
const mockReadFile = jest.fn();

jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: mockExistsSync,
        promises: {
            readdir: mockReaddir,
            stat: mockStat,
            readFile: mockReadFile,
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

jest.unstable_mockModule('../../../src/utils/provider-utils.js', () => ({
    addToUsedPaths: jest.fn(),
    isPathUsed: jest.fn(() => false),
    pathsEqual: jest.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
let scanConfigFiles;

beforeAll(async () => {
    ({ scanConfigFiles } = await import('../../../src/ui-modules/config-scanner.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// scanConfigFiles
// ---------------------------------------------------------------------------
describe('scanConfigFiles', () => {
    test('returns empty array when configs directory does not exist', async () => {
        mockExistsSync.mockReturnValue(false);

        const result = await scanConfigFiles({}, null);

        expect(result).toEqual([]);
        expect(mockReaddir).not.toHaveBeenCalled();
    });

    test('returns empty array when configs directory is empty', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([]);

        const result = await scanConfigFiles({}, null);

        expect(result).toEqual([]);
    });

    test('scans files in configs directory', async () => {
        mockExistsSync.mockReturnValue(true);
        const fakeFile = {
            name: 'config.json',
            isFile: () => true,
            isDirectory: () => false,
        };
        mockReaddir.mockResolvedValue([fakeFile]);
        mockStat.mockResolvedValue({
            size: 100,
            mtime: new Date('2024-01-01T00:00:00.000Z'),
        });
        mockReadFile.mockResolvedValue(JSON.stringify({ some: 'config' }));

        const result = await scanConfigFiles({}, null);

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(1);
        expect(result[0].name).toBe('config.json');
        expect(result[0].type).toBe('config');
    });

    test('ignores files with unsupported extensions', async () => {
        mockExistsSync.mockReturnValue(true);
        const fakeFile = {
            name: 'binary.exe',
            isFile: () => true,
            isDirectory: () => false,
        };
        mockReaddir.mockResolvedValue([fakeFile]);

        const result = await scanConfigFiles({}, null);

        expect(result).toEqual([]);
    });

    test('uses providerPoolManager.providerPools when available', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([]);

        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': [{ GEMINI_OAUTH_CREDS_FILE_PATH: 'configs/gemini/creds.json' }],
            },
        };

        const result = await scanConfigFiles({}, providerPoolManager);

        expect(Array.isArray(result)).toBe(true);
    });

    test('falls back to currentConfig.providerPools when manager lacks providerPools', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([]);

        const currentConfig = {
            providerPools: {
                'gemini-cli-oauth': [{ GEMINI_OAUTH_CREDS_FILE_PATH: 'configs/gemini/creds.json' }],
            },
        };

        const result = await scanConfigFiles(currentConfig, null);

        expect(Array.isArray(result)).toBe(true);
    });

    test('handles readdir error gracefully', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockRejectedValue(new Error('permission denied'));

        const result = await scanConfigFiles({}, null);

        expect(result).toEqual([]);
    });

    test('identifies token-store.json as oauth type', async () => {
        mockExistsSync.mockReturnValue(true);
        const fakeFile = {
            name: 'token-store.json',
            isFile: () => true,
            isDirectory: () => false,
        };
        mockReaddir.mockResolvedValue([fakeFile]);
        mockStat.mockResolvedValue({
            size: 50,
            mtime: new Date('2024-01-01T00:00:00.000Z'),
        });
        mockReadFile.mockResolvedValue(JSON.stringify({ access_token: 'abc' }));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('oauth');
    });

    test('identifies provider_pools.json as provider-pool type', async () => {
        mockExistsSync.mockReturnValue(true);
        const fakeFile = {
            name: 'provider_pools.json',
            isFile: () => true,
            isDirectory: () => false,
        };
        mockReaddir.mockResolvedValue([fakeFile]);
        mockStat.mockResolvedValue({
            size: 200,
            mtime: new Date('2024-01-01T00:00:00.000Z'),
        });
        mockReadFile.mockResolvedValue(JSON.stringify({ 'gemini-cli-oauth': [] }));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('provider-pool');
    });

    test('sets isUsed to false when file is not in usedPaths', async () => {
        const { isPathUsed } = await import('../../../src/utils/provider-utils.js');
        isPathUsed.mockReturnValue(false);

        mockExistsSync.mockReturnValue(true);
        const fakeFile = {
            name: 'config.json',
            isFile: () => true,
            isDirectory: () => false,
        };
        mockReaddir.mockResolvedValue([fakeFile]);
        mockStat.mockResolvedValue({
            size: 100,
            mtime: new Date('2024-01-01T00:00:00.000Z'),
        });
        mockReadFile.mockResolvedValue('{}');

        const result = await scanConfigFiles({}, null);

        expect(result[0].isUsed).toBe(false);
    });
});
