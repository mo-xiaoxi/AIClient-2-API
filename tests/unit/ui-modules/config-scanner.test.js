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

    // --- Filename-based type detection ---

    test('identifies system_prompt file as system-prompt type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'my_system_prompt.txt', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 50, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue('You are a helpful assistant.');

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('system-prompt');
    });

    test('identifies plugins.json as plugins type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'plugins.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 50, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify([]));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('plugins');
    });

    test('identifies usage-cache.json as usage type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'usage-cache.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 50, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({}));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('usage');
    });

    test('identifies potluck-keys file as api-key type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'potluck-keys.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 50, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ key: 'abc' }));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('api-key');
    });

    test('identifies potluck-data file as database type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'potluck-data.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 50, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ data: [] }));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('database');
    });

    // --- Content-based type detection ---

    test('identifies provider-pool type from JSON content with providerPools field', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'my-pools.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ providerPools: {} }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].type).toBe('provider-pool');
    });

    test('identifies api-key type from JSON content with apiKey field', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'keys.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ apiKey: 'sk-abc' }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].type).toBe('api-key');
    });

    test('detects oauth2 provider from JSON with client_id', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'oauth2.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ client_id: 'cid', client_secret: 'csec' }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].provider).toBe('oauth2');
    });

    test('detects service_account provider from JSON with credentials field', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'service.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ credentials: { type: 'service_account' } }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].provider).toBe('service_account');
    });

    test('detects api_key provider from JSON with apiKey field (when oauthProvider=unknown)', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'apikey.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        // Only apiKey, no client_id/access_token/credentials → hits the apiKey provider branch
        mockReadFile.mockResolvedValue(JSON.stringify({ apiKey: 'sk-test' }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].provider).toBe('api_key');
    });

    // --- Base URL detection ---

    test('detects openai provider from base_url containing openai.com', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'openai.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ base_url: 'https://api.openai.com/v1' }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].provider).toBe('openai');
    });

    test('detects claude provider from base_url containing anthropic.com', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'claude.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ base_url: 'https://api.anthropic.com' }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].provider).toBe('claude');
    });

    test('detects gemini provider from base_url containing googleapis.com', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'gemini.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ base_url: 'https://generativelanguage.googleapis.com' }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].provider).toBe('gemini');
    });

    test('detects provider from endpoint field instead of base_url', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'endpoint.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ endpoint: 'https://api.openai.com/v1' }));

        const result = await scanConfigFiles({}, null);

        expect(result[0].provider).toBe('openai');
    });

    // --- Invalid JSON content ---

    test('marks file as invalid when JSON is malformed', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'bad.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 10, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue('{ broken json }');

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].isValid).toBe(false);
        expect(result[0].errorMessage).toContain('JSON Parse Error');
    });

    // --- Non-JSON file types ---

    test('detects private_key provider from .key file with PEM content', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'service.key', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 200, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----');

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].provider).toBe('private_key');
    });

    test('detects api-key type from .txt file containing api_key', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'credentials.txt', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 50, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue('api_key=sk-abc123');

        const result = await scanConfigFiles({}, null);

        expect(result[0].type).toBe('api-key');
        expect(result[0].provider).toBe('api_key');
    });

    test('detects oauth_credentials provider from .oauth file', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'creds.oauth', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 50, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue('some oauth content');

        const result = await scanConfigFiles({}, null);

        expect(result[0].provider).toBe('oauth_credentials');
    });

    // --- File read error ---

    test('marks file as invalid when readFile throws', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'unreadable.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].isValid).toBe(false);
        expect(result[0].errorMessage).toContain('Unable to read file');
    });

    // --- stat failure (outer try/catch returns null, file is excluded) ---

    test('excludes file when stat throws', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'ghost.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockRejectedValue(new Error('ENOENT: no such file'));

        const result = await scanConfigFiles({}, null);

        expect(result).toEqual([]);
    });

    // --- Content preview truncation ---

    test('appends ellipsis to preview when content exceeds 100 chars', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'long.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 200, mtime: new Date('2024-01-01T00:00:00.000Z') });
        const longContent = JSON.stringify({ data: 'x'.repeat(200) });
        mockReadFile.mockResolvedValue(longContent);

        const result = await scanConfigFiles({}, null);

        expect(result[0].preview.endsWith('...')).toBe(true);
    });

    // --- Subdirectory scanning with path-based provider detection ---

    test('detects kiro provider from file in /kiro/ subdirectory', async () => {
        mockExistsSync.mockReturnValue(true);
        // First readdir call: returns a kiro directory
        // Second readdir call: returns a file inside kiro
        mockReaddir.mockImplementation((dirPath) => {
            if (typeof dirPath === 'string' && dirPath.endsWith('kiro')) {
                return Promise.resolve([{ name: 'cred.json', isFile: () => true, isDirectory: () => false }]);
            }
            return Promise.resolve([{ name: 'kiro', isFile: () => false, isDirectory: () => true }]);
        });
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ access_token: 'kiro-token' }));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].provider).toBe('kiro');
    });

    test('detects gemini provider from file in /gemini/ subdirectory', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockImplementation((dirPath) => {
            if (typeof dirPath === 'string' && dirPath.endsWith('gemini')) {
                return Promise.resolve([{ name: 'cred.json', isFile: () => true, isDirectory: () => false }]);
            }
            return Promise.resolve([{ name: 'gemini', isFile: () => false, isDirectory: () => true }]);
        });
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ access_token: 'gemini-token' }));

        const result = await scanConfigFiles({}, null);

        expect(result.length).toBe(1);
        expect(result[0].provider).toBe('gemini');
    });

    // --- getFileUsageInfo body (isPathUsed returns true) ---

    test('populates usageInfo when file is in usedPaths', async () => {
        const { isPathUsed, pathsEqual } = await import('../../../src/utils/provider-utils.js');
        isPathUsed.mockReturnValue(true);
        pathsEqual.mockReturnValue(true);

        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'creds.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ access_token: 'abc' }));

        const currentConfig = { GEMINI_OAUTH_CREDS_FILE_PATH: 'configs/creds.json' };
        const result = await scanConfigFiles(currentConfig, null);

        expect(result.length).toBe(1);
        expect(result[0].isUsed).toBe(true);
        expect(result[0].usageInfo.isUsed).toBe(true);
    });

    test('populates usageInfo for KIRO/QWEN/IFLOW/CODEX main config paths', async () => {
        const { isPathUsed, pathsEqual } = await import('../../../src/utils/provider-utils.js');
        isPathUsed.mockReturnValue(true);
        pathsEqual.mockReturnValue(true);

        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'creds.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ access_token: 'abc' }));

        const currentConfig = {
            KIRO_OAUTH_CREDS_FILE_PATH: 'configs/kiro/creds.json',
            QWEN_OAUTH_CREDS_FILE_PATH: 'configs/qwen/creds.json',
            IFLOW_TOKEN_FILE_PATH: 'configs/iflow/token.json',
            CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/creds.json',
        };
        const result = await scanConfigFiles(currentConfig, null);

        expect(result.length).toBe(1);
        expect(result[0].usageInfo.isUsed).toBe(true);
        expect(result[0].usageInfo.usageDetails.length).toBeGreaterThan(0);
    });

    test('populates usageInfo from providerPools entries', async () => {
        const { isPathUsed, pathsEqual } = await import('../../../src/utils/provider-utils.js');
        isPathUsed.mockReturnValue(true);
        pathsEqual.mockReturnValue(true);

        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'creds.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ access_token: 'abc' }));

        const currentConfig = {
            providerPools: {
                'gemini-cli-oauth': [{
                    GEMINI_OAUTH_CREDS_FILE_PATH: 'configs/gemini/creds.json',
                    KIRO_OAUTH_CREDS_FILE_PATH: 'configs/kiro/creds.json',
                    QWEN_OAUTH_CREDS_FILE_PATH: 'configs/qwen/creds.json',
                    ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'configs/antigravity/creds.json',
                    IFLOW_TOKEN_FILE_PATH: 'configs/iflow/token.json',
                    CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/creds.json',
                    customName: 'test-node',
                    uuid: 'test-uuid',
                    isHealthy: true,
                    isDisabled: false,
                }],
            },
        };
        const result = await scanConfigFiles(currentConfig, null);

        expect(result.length).toBe(1);
        // With pathsEqual=true for all 6 credential paths → multiple matches → 'multiple'
        expect(['provider_pool', 'multiple']).toContain(result[0].usageInfo.usageType);
        expect(result[0].usageInfo.usageDetails.some(d => d.type === 'Provider Pool')).toBe(true);
    });

    test('sets usageType to multiple when file matches both main config and providerPool', async () => {
        const { isPathUsed, pathsEqual } = await import('../../../src/utils/provider-utils.js');
        isPathUsed.mockReturnValue(true);
        pathsEqual.mockReturnValue(true);

        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([{ name: 'creds.json', isFile: () => true, isDirectory: () => false }]);
        mockStat.mockResolvedValue({ size: 100, mtime: new Date('2024-01-01T00:00:00.000Z') });
        mockReadFile.mockResolvedValue(JSON.stringify({ access_token: 'abc' }));

        // Both main config AND providerPools reference the same file → multiple usageDetails
        const currentConfig = {
            GEMINI_OAUTH_CREDS_FILE_PATH: 'configs/gemini/creds.json',
            providerPools: {
                'gemini-cli-oauth': [{
                    GEMINI_OAUTH_CREDS_FILE_PATH: 'configs/gemini/creds.json',
                }],
            },
        };
        const result = await scanConfigFiles(currentConfig, null);

        expect(result.length).toBe(1);
        expect(result[0].usageInfo.usageType).toBe('multiple');
    });
});
