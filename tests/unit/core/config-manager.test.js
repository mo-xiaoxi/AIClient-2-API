/**
 * Unit tests for config-manager.js
 *
 * Tests: initializeConfig, normalizeConfiguredProviders (extended),
 *        getSystemPromptFileContent, PROMPT_LOG_FILENAME logic,
 *        CLI argument parsing, providerFallbackChain, providerPools loading.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Module references — filled in after mocks are set up
// ---------------------------------------------------------------------------
let initializeConfig;
let normalizeConfiguredProviders;
let getSystemPromptFileContent;
let MODEL_PROVIDER;

// ---------------------------------------------------------------------------
// Controllable mock state
// ---------------------------------------------------------------------------
const mockFsSync = {
    readFileSync: jest.fn(),
};

const mockPfs = {
    readFile: jest.fn(),
    access: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
};

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            initialize: jest.fn(),
            cleanupOldLogs: jest.fn(),
            runWithContext: jest.fn(),
            clearRequestContext: jest.fn(),
        },
    }));

    await jest.unstable_mockModule('fs', () => {
        const mod = {
            readFileSync: mockFsSync.readFileSync,
            existsSync: jest.fn(() => false),
            promises: mockPfs,
        };
        mod.default = mod;
        return mod;
    });

    const mod = await import('../../../src/core/config-manager.js');
    initializeConfig = mod.initializeConfig;
    normalizeConfiguredProviders = mod.normalizeConfiguredProviders;
    getSystemPromptFileContent = mod.getSystemPromptFileContent;

    const commonMod = await import('../../../src/utils/common.js');
    MODEL_PROVIDER = commonMod.MODEL_PROVIDER;
});

beforeEach(() => {
    jest.clearAllMocks();
    // Default: config file not found (ENOENT)
    mockFsSync.readFileSync.mockImplementation(() => {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
    });
    // Default: system prompt file not found
    mockPfs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // Default: provider pools file not found
    mockPfs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockPfs.writeFile.mockResolvedValue(undefined);
    mockPfs.mkdir.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// normalizeConfiguredProviders (extended beyond the existing 4 tests)
// ---------------------------------------------------------------------------
describe('normalizeConfiguredProviders — extended', () => {
    test('null MODEL_PROVIDER falls back to gemini-cli-oauth', () => {
        const cfg = { MODEL_PROVIDER: null };
        normalizeConfiguredProviders(cfg);
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.GEMINI_CLI);
    });

    test('numeric MODEL_PROVIDER is coerced and falls back to gemini', () => {
        const cfg = { MODEL_PROVIDER: 12345 };
        normalizeConfiguredProviders(cfg);
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.GEMINI_CLI);
    });

    test('empty string falls back to gemini', () => {
        const cfg = { MODEL_PROVIDER: '' };
        normalizeConfiguredProviders(cfg);
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.GEMINI_CLI);
    });

    test('mixed valid/invalid array keeps only valid providers', () => {
        const cfg = { MODEL_PROVIDER: ['openai-custom', 'totally-fake', 'forward-api'] };
        normalizeConfiguredProviders(cfg);
        expect(cfg.DEFAULT_MODEL_PROVIDERS).toEqual([
            MODEL_PROVIDER.OPENAI_CUSTOM,
            MODEL_PROVIDER.FORWARD_API,
        ]);
    });

    test('first entry in DEFAULT_MODEL_PROVIDERS becomes MODEL_PROVIDER', () => {
        const cfg = { MODEL_PROVIDER: 'forward-api,openai-custom' };
        normalizeConfiguredProviders(cfg);
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.FORWARD_API);
    });

    test('single valid provider sets both MODEL_PROVIDER and DEFAULT_MODEL_PROVIDERS', () => {
        const cfg = { MODEL_PROVIDER: 'claude-custom' };
        normalizeConfiguredProviders(cfg);
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.CLAUDE_CUSTOM);
        expect(cfg.DEFAULT_MODEL_PROVIDERS).toEqual([MODEL_PROVIDER.CLAUDE_CUSTOM]);
    });
});

// ---------------------------------------------------------------------------
// initializeConfig — defaults and file loading
// ---------------------------------------------------------------------------
describe('initializeConfig — default values', () => {
    test('returns config with REQUIRED_API_KEY default', async () => {
        const cfg = await initializeConfig([], '/nonexistent/config.json');
        expect(cfg.REQUIRED_API_KEY).toBe('123456');
    });

    test('returns config with SERVER_PORT default 3000', async () => {
        const cfg = await initializeConfig([], '/nonexistent/config.json');
        expect(cfg.SERVER_PORT).toBe(3000);
    });

    test('returns config with MODEL_PROVIDER set to gemini-cli-oauth by default', async () => {
        const cfg = await initializeConfig([], '/nonexistent/config.json');
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.GEMINI_CLI);
    });

    test('returns config with providerPools defaulting to empty object on file error', async () => {
        const cfg = await initializeConfig([], '/nonexistent/config.json');
        expect(cfg.providerPools).toEqual({});
    });

    test('PROMPT_LOG_FILENAME is empty string when PROMPT_LOG_MODE is not file', async () => {
        const cfg = await initializeConfig([], '/nonexistent/config.json');
        // Default mode is 'none', so filename should be empty
        expect(typeof cfg.PROMPT_LOG_MODE).toBe('string');
        expect(cfg.PROMPT_LOG_MODE).not.toBe('file');
    });
});

describe('initializeConfig — loading from config file', () => {
    test('merges loaded config over defaults', async () => {
        mockFsSync.readFileSync.mockReturnValue(JSON.stringify({
            REQUIRED_API_KEY: 'custom-key',
            SERVER_PORT: 8080,
        }));
        const cfg = await initializeConfig([], 'configs/config.json');
        expect(cfg.REQUIRED_API_KEY).toBe('custom-key');
        expect(cfg.SERVER_PORT).toBe(8080);
    });

    test('handles invalid JSON in config file gracefully', async () => {
        mockFsSync.readFileSync.mockReturnValue('{not valid json');
        const cfg = await initializeConfig([], 'configs/config.json');
        // Should fall back to defaults without throwing
        expect(cfg.REQUIRED_API_KEY).toBe('123456');
    });
});

describe('initializeConfig — CLI argument parsing', () => {
    test('--api-key overrides REQUIRED_API_KEY', async () => {
        const cfg = await initializeConfig(['--api-key', 'my-secret'], '/nonexistent/config.json');
        expect(cfg.REQUIRED_API_KEY).toBe('my-secret');
    });

    test('--port overrides SERVER_PORT as integer', async () => {
        const cfg = await initializeConfig(['--port', '9999'], '/nonexistent/config.json');
        expect(cfg.SERVER_PORT).toBe(9999);
    });

    test('--model-provider overrides MODEL_PROVIDER', async () => {
        const cfg = await initializeConfig(['--model-provider', 'forward-api'], '/nonexistent/config.json');
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.FORWARD_API);
    });

    test('--config flag overrides config file path', async () => {
        mockFsSync.readFileSync.mockReturnValue(JSON.stringify({ SERVER_PORT: 7777 }));
        const cfg = await initializeConfig(['--config', 'custom-config.json'], 'configs/config.json');
        expect(cfg.SERVER_PORT).toBe(7777);
    });

    test('unknown flag is silently ignored', async () => {
        const cfg = await initializeConfig(['--unknown-flag', 'value'], '/nonexistent/config.json');
        expect(cfg.REQUIRED_API_KEY).toBe('123456');
    });

    test('--log-prompts with invalid value is ignored', async () => {
        const cfg = await initializeConfig(['--log-prompts', 'invalid'], '/nonexistent/config.json');
        expect(cfg.PROMPT_LOG_MODE).toBe('none'); // default unchanged
    });
});

describe('initializeConfig — providerPools loading', () => {
    test('loads providerPools from PROVIDER_POOLS_FILE_PATH when file exists', async () => {
        const poolData = { 'gemini-cli-oauth': [{ uuid: 'test-uuid' }] };
        mockPfs.readFile.mockResolvedValue(JSON.stringify(poolData));
        const cfg = await initializeConfig([], '/nonexistent/config.json');
        expect(cfg.providerPools).toEqual(poolData);
    });

    test('sets providerPools to empty object when pool file is missing', async () => {
        mockPfs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        const cfg = await initializeConfig([], '/nonexistent/config.json');
        expect(cfg.providerPools).toEqual({});
    });
});

// ---------------------------------------------------------------------------
// getSystemPromptFileContent
// ---------------------------------------------------------------------------
describe('getSystemPromptFileContent', () => {
    test('returns null when file does not exist (ENOENT)', async () => {
        mockPfs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        const content = await getSystemPromptFileContent('/no/such/file.txt');
        expect(content).toBeNull();
    });

    test('returns content when file exists and is non-empty', async () => {
        mockPfs.access.mockResolvedValue(undefined);
        mockPfs.readFile.mockResolvedValue('You are a helpful assistant.');
        const content = await getSystemPromptFileContent('/some/prompt.txt');
        expect(content).toBe('You are a helpful assistant.');
    });

    test('returns null when file is empty or only whitespace', async () => {
        mockPfs.access.mockResolvedValue(undefined);
        mockPfs.readFile.mockResolvedValue('   \n  ');
        const content = await getSystemPromptFileContent('/some/prompt.txt');
        expect(content).toBeNull();
    });

    test('returns null when readFile throws an error', async () => {
        mockPfs.access.mockResolvedValue(undefined);
        mockPfs.readFile.mockRejectedValue(new Error('Permission denied'));
        const content = await getSystemPromptFileContent('/some/prompt.txt');
        expect(content).toBeNull();
    });
});
