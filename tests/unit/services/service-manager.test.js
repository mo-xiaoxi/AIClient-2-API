/**
 * Unit tests for services/service-manager.js
 *
 * Tests: initApiService, getApiService, getApiServiceWithFallback,
 *        getProviderPoolManager, markProviderUnhealthy, getProviderStatus,
 *        autoLinkProviderConfigs routing helpers.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Controllable mock functions
// ---------------------------------------------------------------------------
const mockGetServiceAdapter = jest.fn();
const mockServiceInstances = {};

const mockProviderPoolManagerInstance = {
    providerPools: {},
    providerStatus: {},
    initializeProviderStatus: jest.fn(),
    warmupNodes: jest.fn().mockResolvedValue(undefined),
    checkAndRefreshExpiringNodes: jest.fn().mockResolvedValue(undefined),
    performHealthChecks: jest.fn().mockResolvedValue(undefined),
    selectProvider: jest.fn(),
    selectProviderWithFallback: jest.fn(),
    acquireSlotWithFallback: jest.fn(),
    markProviderUnhealthy: jest.fn(),
    getProviderPools: jest.fn().mockReturnValue([]),
    _enqueueRefresh: jest.fn(),
};

let MockProviderPoolManager;

// ---------------------------------------------------------------------------
// Module references
// ---------------------------------------------------------------------------
let initApiService;
let getApiService;
let getApiServiceWithFallback;
let getProviderPoolManager;
let markProviderUnhealthy;
let getProviderStatus;
let autoLinkProviderConfigs;

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

    MockProviderPoolManager = jest.fn().mockImplementation(() => mockProviderPoolManagerInstance);

    await jest.unstable_mockModule('../../../src/providers/provider-pool-manager.js', () => ({
        ProviderPoolManager: MockProviderPoolManager,
    }));

    await jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
        getServiceAdapter: mockGetServiceAdapter,
        serviceInstances: mockServiceInstances,
    }));

    await jest.unstable_mockModule('deepmerge', () => ({
        default: (a, b) => ({ ...a, ...b }),
    }));

    await jest.unstable_mockModule('fs', () => ({
        existsSync: jest.fn().mockReturnValue(false),
        readFileSync: jest.fn().mockReturnValue('{}'),
        promises: {
            readdir: jest.fn().mockResolvedValue([]),
            writeFile: jest.fn().mockResolvedValue(undefined),
        },
    }));

    await jest.unstable_mockModule('../../../src/utils/provider-utils.js', () => ({
        PROVIDER_MAPPINGS: [],
        createProviderConfig: jest.fn((opts) => ({ [opts.credPathKey]: opts.credPath })),
        addToUsedPaths: jest.fn(),
        isPathUsed: jest.fn().mockReturnValue(false),
        getFileName: jest.fn((p) => p.split('/').pop()),
        formatSystemPath: jest.fn((p) => p),
    }));

    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        MODEL_PROVIDER: {
            AUTO: 'auto',
        },
    }));

    const mod = await import('../../../src/services/service-manager.js');
    initApiService = mod.initApiService;
    getApiService = mod.getApiService;
    getApiServiceWithFallback = mod.getApiServiceWithFallback;
    getProviderPoolManager = mod.getProviderPoolManager;
    markProviderUnhealthy = mod.markProviderUnhealthy;
    getProviderStatus = mod.getProviderStatus;
    autoLinkProviderConfigs = mod.autoLinkProviderConfigs;
});

beforeEach(() => {
    jest.clearAllMocks();
    MockProviderPoolManager.mockImplementation(() => mockProviderPoolManagerInstance);
    mockProviderPoolManagerInstance.warmupNodes.mockResolvedValue(undefined);
    mockProviderPoolManagerInstance.checkAndRefreshExpiringNodes.mockResolvedValue(undefined);
    mockProviderPoolManagerInstance.selectProvider.mockReset();
    mockProviderPoolManagerInstance.selectProviderWithFallback.mockReset();
    mockProviderPoolManagerInstance.acquireSlotWithFallback.mockReset();
    mockGetServiceAdapter.mockReset();
    mockGetServiceAdapter.mockReturnValue({ type: 'mock-adapter' });
});

// ---------------------------------------------------------------------------
// Tests: initApiService
// ---------------------------------------------------------------------------
describe('initApiService()', () => {
    test('returns serviceInstances when no provider pools configured', async () => {
        const config = {};
        const result = await initApiService(config);
        expect(result).toBe(mockServiceInstances);
    });

    test('creates ProviderPoolManager when provider pools are configured', async () => {
        const config = {
            providerPools: {
                'openai-custom': [{ uuid: 'node-1' }],
            },
            DEFAULT_MODEL_PROVIDERS: ['openai-custom'],
        };
        await initApiService(config, false);
        expect(MockProviderPoolManager).toHaveBeenCalled();
    });

    test('skips providers not in DEFAULT_MODEL_PROVIDERS', async () => {
        const config = {
            providerPools: {
                'openai-custom': [{ uuid: 'node-1' }],
                'claude-custom': [{ uuid: 'node-2' }],
            },
            DEFAULT_MODEL_PROVIDERS: ['openai-custom'],
        };
        await initApiService(config, false);
        // getServiceAdapter should only be called for openai-custom (1 node)
        expect(mockGetServiceAdapter).toHaveBeenCalledTimes(1);
    });

    test('skips disabled nodes', async () => {
        const config = {
            providerPools: {
                'openai-custom': [
                    { uuid: 'node-1', isDisabled: true },
                    { uuid: 'node-2' },
                ],
            },
            DEFAULT_MODEL_PROVIDERS: ['openai-custom'],
        };
        await initApiService(config, false);
        // Only node-2 should be initialized
        expect(mockGetServiceAdapter).toHaveBeenCalledTimes(1);
    });

    test('handles getServiceAdapter failure gracefully', async () => {
        mockGetServiceAdapter.mockImplementationOnce(() => { throw new Error('init failed'); });
        const config = {
            providerPools: {
                'openai-custom': [{ uuid: 'node-fail' }],
            },
            DEFAULT_MODEL_PROVIDERS: ['openai-custom'],
        };
        // Should not throw
        await expect(initApiService(config, false)).resolves.not.toThrow();
    });

    test('triggers warmup when isReady=true', async () => {
        const config = {
            providerPools: {
                'openai-custom': [{ uuid: 'node-1' }],
            },
        };
        await initApiService(config, true);
        expect(mockProviderPoolManagerInstance.warmupNodes).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: getProviderPoolManager
// ---------------------------------------------------------------------------
describe('getProviderPoolManager()', () => {
    test('returns null before initApiService with no pools', async () => {
        // After init with no pools, manager should be null
        await initApiService({});
        const pm = getProviderPoolManager();
        expect(pm).toBeNull();
    });

    test('returns ProviderPoolManager after initApiService with pools', async () => {
        const config = {
            providerPools: { 'openai-custom': [] },
        };
        await initApiService(config, false);
        const pm = getProviderPoolManager();
        expect(pm).toBe(mockProviderPoolManagerInstance);
    });
});

// ---------------------------------------------------------------------------
// Tests: getApiService
// ---------------------------------------------------------------------------
describe('getApiService()', () => {
    test('calls getServiceAdapter with config when no pool manager', async () => {
        await initApiService({}); // reset to no pool manager
        const config = { MODEL_PROVIDER: 'openai-custom' };
        await getApiService(config, 'gpt-4');
        expect(mockGetServiceAdapter).toHaveBeenCalledWith(config);
    });

    test('returns null for AUTO provider with no model name', async () => {
        await initApiService({});
        const config = { MODEL_PROVIDER: 'auto' };
        const result = await getApiService(config, null);
        expect(result).toBeNull();
    });

    test('throws error for AUTO provider with model name but no prefix', async () => {
        await initApiService({});
        const config = { MODEL_PROVIDER: 'auto' };
        await expect(getApiService(config, 'gpt-4')).rejects.toThrow('Auto-routing failed');
    });

    test('resolves prefix from model name with pool manager', async () => {
        // Setup pool manager with known provider
        const config = {
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.providerStatus['openai-custom'] = { healthy: 1 };
        mockProviderPoolManagerInstance.selectProvider.mockResolvedValue({ uuid: 'n1', MODEL_PROVIDER: 'openai-custom' });

        const reqConfig = {
            MODEL_PROVIDER: 'openai-custom',
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        await getApiService(reqConfig, 'openai-custom:gpt-4');
        expect(mockGetServiceAdapter).toHaveBeenCalled();
    });

    test('throws when no healthy provider found in pool', async () => {
        const config = {
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.selectProvider.mockResolvedValue(null);

        const reqConfig = {
            MODEL_PROVIDER: 'openai-custom',
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        await expect(getApiService(reqConfig, 'gpt-4')).rejects.toThrow('No healthy provider');
    });
});

// ---------------------------------------------------------------------------
// Tests: getApiServiceWithFallback
// ---------------------------------------------------------------------------
describe('getApiServiceWithFallback()', () => {
    test('returns service object with metadata', async () => {
        await initApiService({});
        const config = { MODEL_PROVIDER: 'openai-custom' };
        const result = await getApiServiceWithFallback(config, 'gpt-4');
        expect(result).toHaveProperty('service');
        expect(result).toHaveProperty('serviceConfig');
        expect(result).toHaveProperty('actualProviderType');
        expect(result).toHaveProperty('isFallback');
    });

    test('returns null service for AUTO with no model', async () => {
        await initApiService({});
        const config = { MODEL_PROVIDER: 'auto' };
        const result = await getApiServiceWithFallback(config, null);
        expect(result.service).toBeNull();
    });

    test('uses selectProviderWithFallback when pool manager is available', async () => {
        const config = {
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.selectProviderWithFallback.mockResolvedValue({
            config: { uuid: 'n1', MODEL_PROVIDER: 'openai-custom' },
            actualProviderType: 'openai-custom',
            isFallback: false,
            actualModel: 'gpt-4',
        });

        const reqConfig = {
            MODEL_PROVIDER: 'openai-custom',
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        const result = await getApiServiceWithFallback(reqConfig, 'gpt-4');
        expect(mockProviderPoolManagerInstance.selectProviderWithFallback).toHaveBeenCalled();
        expect(result.isFallback).toBe(false);
    });

    test('uses acquireSlotWithFallback when acquireSlot option is true', async () => {
        const config = {
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.acquireSlotWithFallback.mockResolvedValue({
            config: { uuid: 'n1', MODEL_PROVIDER: 'openai-custom' },
            actualProviderType: 'openai-custom',
            isFallback: false,
            actualModel: 'gpt-4',
        });

        const reqConfig = {
            MODEL_PROVIDER: 'openai-custom',
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        const result = await getApiServiceWithFallback(reqConfig, 'gpt-4', { acquireSlot: true });
        expect(mockProviderPoolManagerInstance.acquireSlotWithFallback).toHaveBeenCalled();
    });

    test('throws when no healthy provider found with fallback', async () => {
        const config = {
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.selectProviderWithFallback.mockResolvedValue(null);

        const reqConfig = {
            MODEL_PROVIDER: 'openai-custom',
            providerPools: { 'openai-custom': [{ uuid: 'n1' }] },
        };
        await expect(getApiServiceWithFallback(reqConfig, 'gpt-4')).rejects.toThrow('No healthy provider');
    });
});

// ---------------------------------------------------------------------------
// Tests: markProviderUnhealthy
// ---------------------------------------------------------------------------
describe('markProviderUnhealthy()', () => {
    test('does nothing when pool manager is null', async () => {
        await initApiService({});
        // Should not throw
        expect(() => markProviderUnhealthy('openai-custom', { uuid: 'n1' })).not.toThrow();
    });

    test('delegates to pool manager when available', async () => {
        const config = { providerPools: { 'openai-custom': [] } };
        await initApiService(config, false);
        markProviderUnhealthy('openai-custom', { uuid: 'n1' });
        expect(mockProviderPoolManagerInstance.markProviderUnhealthy).toHaveBeenCalledWith('openai-custom', { uuid: 'n1' });
    });
});

// ---------------------------------------------------------------------------
// Tests: getProviderStatus
// ---------------------------------------------------------------------------
describe('getProviderStatus()', () => {
    test('returns status object with expected shape', async () => {
        await initApiService({});
        const config = {};
        const result = await getProviderStatus(config);
        expect(result).toHaveProperty('providerPoolsSlim');
        expect(result).toHaveProperty('unhealthySummeryMessage');
        expect(result).toHaveProperty('count');
        expect(result).toHaveProperty('unhealthyCount');
        expect(result).toHaveProperty('unhealthyRatio');
    });

    test('returns count=0 when no pools configured', async () => {
        await initApiService({});
        const result = await getProviderStatus({});
        expect(result.count).toBe(0);
        expect(result.unhealthyCount).toBe(0);
    });

    test('uses pool manager pools when available', async () => {
        const config = {
            providerPools: {
                'openai-custom': [{ uuid: 'n1', OPENAI_BASE_URL: 'https://api.openai.com', isHealthy: true }],
            },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.providerPools = config.providerPools;

        const result = await getProviderStatus({});
        expect(result.count).toBe(1);
    });

    test('filters disabled providers from results', async () => {
        const config = {
            providerPools: {
                'openai-custom': [
                    { uuid: 'n1', OPENAI_BASE_URL: 'https://api.openai.com', isDisabled: true },
                    { uuid: 'n2', OPENAI_BASE_URL: 'https://api.openai.com' },
                ],
            },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.providerPools = config.providerPools;

        const result = await getProviderStatus({});
        expect(result.count).toBe(1); // only n2
    });

    test('filters by provider when options.provider is set', async () => {
        const config = {
            providerPools: {
                'openai-custom': [{ uuid: 'n1', OPENAI_BASE_URL: 'https://api.openai.com' }],
                'claude-custom': [{ uuid: 'n2', CLAUDE_BASE_URL: 'https://api.anthropic.com' }],
            },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.providerPools = config.providerPools;

        const result = await getProviderStatus({}, { provider: 'openai-custom' });
        expect(result.count).toBe(1);
        expect(result.providerPoolsSlim[0].provider).toBe('openai-custom');
    });

    test('computes unhealthyRatio correctly', async () => {
        const config = {
            providerPools: {
                'openai-custom': [
                    { uuid: 'n1', OPENAI_BASE_URL: 'http://a', isHealthy: false },
                    { uuid: 'n2', OPENAI_BASE_URL: 'http://b', isHealthy: true },
                ],
            },
        };
        await initApiService(config, false);
        mockProviderPoolManagerInstance.providerPools = config.providerPools;

        const result = await getProviderStatus({});
        expect(result.unhealthyCount).toBe(1);
        expect(result.unhealthyRatio).toBe(0.5);
    });
});

// ---------------------------------------------------------------------------
// Tests: autoLinkProviderConfigs
// ---------------------------------------------------------------------------
describe('autoLinkProviderConfigs()', () => {
    test('initializes providerPools if missing from config', async () => {
        const config = {};
        await autoLinkProviderConfigs(config);
        expect(config.providerPools).toBeDefined();
    });

    test('returns existing providerPools when no new configs found', async () => {
        const config = { providerPools: { 'openai-custom': [] } };
        const result = await autoLinkProviderConfigs(config);
        expect(result).toEqual({ 'openai-custom': [] });
    });
});
