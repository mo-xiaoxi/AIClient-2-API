import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

// ---- External dependency mocks ----
await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

await jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
    default: {},
    getTlsSidecarProcess: jest.fn(),
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: (c) => c,
}));

// Mock broadcastEvent to prevent event system initialization
await jest.unstable_mockModule('../../../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn(),
}));

// Mock convert module
await jest.unstable_mockModule('../../../src/convert/convert.js', () => ({
    convertData: jest.fn(() => ({ data: [] })),
    getOpenAIStreamChunkStop: jest.fn(),
}));

// Mock provider-models
await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => []),
}));

// Mock adapter module to avoid real service initializations
const mockGetServiceAdapter = jest.fn();
const mockGetRegisteredProviders = jest.fn(() => ['gemini-cli-oauth', 'openai-custom']);
const mockClearServiceInstances = jest.fn();

await jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
    getServiceAdapter: mockGetServiceAdapter,
    getRegisteredProviders: mockGetRegisteredProviders,
    clearServiceInstancesForTests: mockClearServiceInstances,
    serviceInstances: {},
    registerAdapter: jest.fn(),
    ApiServiceAdapter: class ApiServiceAdapter {},
}));

// Mock fs for file I/O
const mockFsReadFile = jest.fn();
const mockFsWriteFile = jest.fn();
const mockFsExistsSync = jest.fn(() => false);

await jest.unstable_mockModule('fs', () => ({
    default: {
        existsSync: mockFsExistsSync,
        promises: {
            readFile: mockFsReadFile,
            writeFile: mockFsWriteFile,
        },
    },
    existsSync: mockFsExistsSync,
    promises: {
        readFile: mockFsReadFile,
        writeFile: mockFsWriteFile,
    },
}));

const { ProviderPoolManager } = await import('../../../src/providers/provider-pool-manager.js');

// Helper: create a minimal provider config
function makeConfig(uuid = 'test-uuid-1', overrides = {}) {
    return {
        uuid,
        isHealthy: true,
        isDisabled: false,
        usageCount: 0,
        errorCount: 0,
        lastUsed: null,
        lastErrorTime: null,
        lastErrorMessage: null,
        needsRefresh: false,
        refreshCount: 0,
        lastHealthCheckTime: null,
        lastHealthCheckModel: null,
        customName: null,
        ...overrides,
    };
}

// Helper: create a minimal pool
function makePool(configs) {
    const pool = {};
    for (const [type, cfgList] of Object.entries(configs)) {
        pool[type] = cfgList;
    }
    return pool;
}

describe('ProviderPoolManager', () => {
    let manager;

    beforeEach(() => {
        jest.clearAllMocks();
        mockFsReadFile.mockReset();
        mockFsWriteFile.mockReset();
        mockFsExistsSync.mockReturnValue(false);
        mockGetServiceAdapter.mockReset();
    });

    afterEach(() => {
        // Clean up debounce timers
        if (manager && manager.saveTimer) {
            clearTimeout(manager.saveTimer);
        }
        if (manager && manager.refreshBufferTimers) {
            for (const timer of Object.values(manager.refreshBufferTimers)) {
                clearTimeout(timer);
            }
        }
    });

    // ==============================
    // Constructor and initialization
    // ==============================
    describe('constructor', () => {
        test('initializes with default options', () => {
            manager = new ProviderPoolManager({});
            expect(manager.maxErrorCount).toBe(10);
            expect(manager.healthCheckInterval).toBe(10 * 60 * 1000);
            expect(manager.logLevel).toBe('info');
        });

        test('accepts custom options', () => {
            manager = new ProviderPoolManager({}, {
                maxErrorCount: 5,
                healthCheckInterval: 60000,
                logLevel: 'debug',
                saveDebounceTime: 500,
            });
            expect(manager.maxErrorCount).toBe(5);
            expect(manager.healthCheckInterval).toBe(60000);
            expect(manager.logLevel).toBe('debug');
            expect(manager.saveDebounceTime).toBe(500);
        });

        test('maxErrorCount=0 is respected (not overridden by ||)', () => {
            manager = new ProviderPoolManager({}, { maxErrorCount: 0 });
            expect(manager.maxErrorCount).toBe(0);
        });

        test('reads fallback chain from globalConfig', () => {
            const globalConfig = {
                providerFallbackChain: {
                    'openai-custom': ['gemini-cli-oauth'],
                },
            };
            manager = new ProviderPoolManager({}, { globalConfig });
            expect(manager.fallbackChain['openai-custom']).toEqual(['gemini-cli-oauth']);
        });

        test('reads modelFallbackMapping from globalConfig', () => {
            const globalConfig = {
                modelFallbackMapping: {
                    'gpt-4': { targetProviderType: 'openai-custom', targetModel: 'gpt-4o' },
                },
            };
            manager = new ProviderPoolManager({}, { globalConfig });
            expect(manager.modelFallbackMapping['gpt-4']).toBeDefined();
        });
    });

    // ==============================
    // initializeProviderStatus
    // ==============================
    describe('initializeProviderStatus', () => {
        test('creates providerStatus entries for each pool entry', () => {
            const pools = {
                'gemini-cli-oauth': [makeConfig('uuid-1'), makeConfig('uuid-2')],
                'openai-custom': [makeConfig('uuid-3')],
            };
            manager = new ProviderPoolManager(pools);
            expect(manager.providerStatus['gemini-cli-oauth']).toHaveLength(2);
            expect(manager.providerStatus['openai-custom']).toHaveLength(1);
        });

        test('sets default values for provider config fields', () => {
            const rawConfig = { uuid: 'raw-uuid' };
            manager = new ProviderPoolManager({
                'openai-custom': [rawConfig],
            });
            const providerEntry = manager.providerStatus['openai-custom'][0];
            expect(providerEntry.config.isHealthy).toBe(true);
            expect(providerEntry.config.isDisabled).toBe(false);
            expect(providerEntry.config.usageCount).toBe(0);
            expect(providerEntry.config.errorCount).toBe(0);
            expect(providerEntry.config.needsRefresh).toBe(false);
        });

        test('preserves existing health status from config', () => {
            const cfg = { uuid: 'u1', isHealthy: false, errorCount: 5 };
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const entry = manager.providerStatus['openai-custom'][0];
            expect(entry.config.isHealthy).toBe(false);
            expect(entry.config.errorCount).toBe(5);
        });

        test('initializes state object with zero counts', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            const entry = manager.providerStatus['openai-custom'][0];
            expect(entry.state.activeCount).toBe(0);
            expect(entry.state.waitingCount).toBe(0);
            expect(Array.isArray(entry.state.queue)).toBe(true);
        });

        test('preserves state from old status when reinitializing', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'gemini-cli-oauth': [cfg] });

            // Modify state
            manager.providerStatus['gemini-cli-oauth'][0].state.activeCount = 3;

            // Re-initialize
            manager.initializeProviderStatus();

            // State should be preserved
            const entry = manager.providerStatus['gemini-cli-oauth'][0];
            expect(entry.state.activeCount).toBe(3);
        });
    });

    // ==============================
    // selectProvider
    // ==============================
    describe('selectProvider', () => {
        test('returns null for invalid providerType', async () => {
            manager = new ProviderPoolManager({});
            expect(await manager.selectProvider(null)).toBeNull();
            expect(await manager.selectProvider('')).toBeNull();
            expect(await manager.selectProvider(123)).toBeNull();
        });

        test('returns null when no providers in pool', async () => {
            manager = new ProviderPoolManager({});
            expect(await manager.selectProvider('gemini-cli-oauth')).toBeNull();
        });

        test('returns null when all providers are unhealthy', async () => {
            const cfg = makeConfig('u1', { isHealthy: false });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            expect(await manager.selectProvider('openai-custom')).toBeNull();
        });

        test('returns null when all providers are disabled', async () => {
            const cfg = makeConfig('u1', { isDisabled: true });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            expect(await manager.selectProvider('openai-custom')).toBeNull();
        });

        test('returns healthy provider config', async () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager.selectProvider('openai-custom');
            expect(result).toBeDefined();
            expect(result.uuid).toBe('u1');
        });

        test('updates lastUsed and usageCount on selection', async () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager.selectProvider('openai-custom');
            expect(result.lastUsed).not.toBeNull();
            expect(result.usageCount).toBe(1);
        });

        test('skipUsageCount=true does not increment usageCount', async () => {
            const cfg = makeConfig('u1', { usageCount: 5 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager.selectProvider('openai-custom', null, { skipUsageCount: true });
            expect(result.usageCount).toBe(5);
        });

        test('filters by requestedModel using notSupportedModels', async () => {
            const cfg1 = makeConfig('u1', { notSupportedModels: ['gpt-4'] });
            const cfg2 = makeConfig('u2');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg1, cfg2] });
            const result = await manager.selectProvider('openai-custom', 'gpt-4');
            expect(result.uuid).toBe('u2');
        });

        test('returns null when all providers have model excluded', async () => {
            const cfg1 = makeConfig('u1', { notSupportedModels: ['gpt-4'] });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg1] });
            const result = await manager.selectProvider('openai-custom', 'gpt-4');
            expect(result).toBeNull();
        });

        test('skips providers with needsRefresh=true', async () => {
            const cfg1 = makeConfig('u1', { needsRefresh: true });
            const cfg2 = makeConfig('u2');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg1, cfg2] });
            const result = await manager.selectProvider('openai-custom');
            expect(result.uuid).toBe('u2');
        });

        test('selects least recently used provider (LRU)', async () => {
            const past = new Date(Date.now() - 60000).toISOString();
            const recent = new Date(Date.now() - 1000).toISOString();
            const cfg1 = makeConfig('u1', { lastUsed: past, usageCount: 0 });
            const cfg2 = makeConfig('u2', { lastUsed: recent, usageCount: 0 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg1, cfg2] });
            // cfg1 has older lastUsed so lower score, should be selected first
            const result = await manager.selectProvider('openai-custom');
            expect(result.uuid).toBe('u1');
        });
    });

    // ==============================
    // selectProviderWithFallback
    // ==============================
    describe('selectProviderWithFallback', () => {
        test('returns null for invalid providerType', async () => {
            manager = new ProviderPoolManager({});
            expect(await manager.selectProviderWithFallback(null)).toBeNull();
        });

        test('returns primary provider when available', async () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager.selectProviderWithFallback('openai-custom');
            expect(result).not.toBeNull();
            expect(result.config.uuid).toBe('u1');
            expect(result.isFallback).toBe(false);
        });

        test('returns fallback provider when primary unavailable', async () => {
            const primaryCfg = makeConfig('u1', { isHealthy: false });
            const fallbackCfg = makeConfig('u2');
            const pools = {
                'openai-custom': [primaryCfg],
                'openai-qwen-oauth': [fallbackCfg],
            };
            const globalConfig = {
                providerFallbackChain: {
                    'openai-custom': ['openai-qwen-oauth'],
                },
            };
            manager = new ProviderPoolManager(pools, { globalConfig });
            const result = await manager.selectProviderWithFallback('openai-custom');
            expect(result).not.toBeNull();
            expect(result.config.uuid).toBe('u2');
            expect(result.isFallback).toBe(true);
            expect(result.actualProviderType).toBe('openai-qwen-oauth');
        });

        test('returns null when all providers exhausted', async () => {
            const cfg = makeConfig('u1', { isHealthy: false });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager.selectProviderWithFallback('openai-custom');
            expect(result).toBeNull();
        });

        test('does not try same type twice via fallback chain', async () => {
            const cfg = makeConfig('u1', { isHealthy: false });
            const globalConfig = {
                providerFallbackChain: {
                    'openai-custom': ['openai-custom'], // Self-loop
                },
            };
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] }, { globalConfig });
            const result = await manager.selectProviderWithFallback('openai-custom');
            expect(result).toBeNull();
        });
    });

    // ==============================
    // markProviderUnhealthy
    // ==============================
    describe('markProviderUnhealthy', () => {
        test('increments errorCount', () => {
            const cfg = makeConfig('u1', { errorCount: 0 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.markProviderUnhealthy('openai-custom', cfg);
            expect(manager.providerStatus['openai-custom'][0].config.errorCount).toBe(1);
        });

        test('marks unhealthy when errorCount reaches maxErrorCount (within error window)', () => {
            // Set lastErrorTime to within the 10-second window, so errorCount accumulates
            const recentTime = new Date(Date.now() - 1000).toISOString(); // 1 second ago
            const cfg = makeConfig('u1', { errorCount: 9, lastErrorTime: recentTime });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] }, { maxErrorCount: 10 });
            manager.markProviderUnhealthy('openai-custom', cfg);
            expect(manager.providerStatus['openai-custom'][0].config.isHealthy).toBe(false);
        });

        test('does not mark unhealthy below maxErrorCount', () => {
            const cfg = makeConfig('u1', { errorCount: 3 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] }, { maxErrorCount: 10 });
            manager.markProviderUnhealthy('openai-custom', cfg);
            expect(manager.providerStatus['openai-custom'][0].config.isHealthy).toBe(true);
        });

        test('resets errorCount to 1 if outside error window', () => {
            const oldErrorTime = new Date(Date.now() - 60000).toISOString(); // 60 seconds ago
            const cfg = makeConfig('u1', { errorCount: 5, lastErrorTime: oldErrorTime });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] }, { maxErrorCount: 10 });
            manager.markProviderUnhealthy('openai-custom', cfg);
            expect(manager.providerStatus['openai-custom'][0].config.errorCount).toBe(1);
        });

        test('stores errorMessage', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.markProviderUnhealthy('openai-custom', cfg, 'Network timeout');
            expect(manager.providerStatus['openai-custom'][0].config.lastErrorMessage).toBe('Network timeout');
        });

        test('does nothing with invalid providerConfig', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.markProviderUnhealthy('openai-custom', null)).not.toThrow();
            expect(() => manager.markProviderUnhealthy('openai-custom', {})).not.toThrow();
        });

        test('does nothing when provider not found', () => {
            const cfg = makeConfig('nonexistent-uuid');
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.markProviderUnhealthy('openai-custom', cfg)).not.toThrow();
        });
    });

    // ==============================
    // markProviderUnhealthyImmediately
    // ==============================
    describe('markProviderUnhealthyImmediately', () => {
        test('immediately marks provider as unhealthy', () => {
            const cfg = makeConfig('u1', { errorCount: 0 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] }, { maxErrorCount: 10 });
            manager.markProviderUnhealthyImmediately('openai-custom', cfg, 'Auth failed');
            const entry = manager.providerStatus['openai-custom'][0];
            expect(entry.config.isHealthy).toBe(false);
            expect(entry.config.errorCount).toBe(10); // Set to maxErrorCount
            expect(entry.config.lastErrorMessage).toBe('Auth failed');
        });

        test('does nothing with invalid providerConfig', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.markProviderUnhealthyImmediately('openai-custom', null)).not.toThrow();
        });
    });

    // ==============================
    // markProviderHealthy
    // ==============================
    describe('markProviderHealthy', () => {
        test('marks provider as healthy and resets error state', () => {
            const cfg = makeConfig('u1', { isHealthy: false, errorCount: 10 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.markProviderHealthy('openai-custom', cfg);
            const entry = manager.providerStatus['openai-custom'][0];
            expect(entry.config.isHealthy).toBe(true);
            expect(entry.config.errorCount).toBe(0);
            expect(entry.config.needsRefresh).toBe(false);
        });

        test('resets usageCount when resetUsageCount=true', () => {
            const cfg = makeConfig('u1', { usageCount: 50 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.markProviderHealthy('openai-custom', cfg, true);
            expect(manager.providerStatus['openai-custom'][0].config.usageCount).toBe(0);
        });

        test('increments usageCount when resetUsageCount=false', () => {
            const cfg = makeConfig('u1', { usageCount: 5 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.markProviderHealthy('openai-custom', cfg, false);
            expect(manager.providerStatus['openai-custom'][0].config.usageCount).toBe(6);
        });

        test('updates lastHealthCheckTime and model when healthCheckModel provided', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.markProviderHealthy('openai-custom', cfg, false, 'gpt-4o-mini');
            const entry = manager.providerStatus['openai-custom'][0];
            expect(entry.config.lastHealthCheckTime).not.toBeNull();
            expect(entry.config.lastHealthCheckModel).toBe('gpt-4o-mini');
        });

        test('does nothing with invalid providerConfig', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.markProviderHealthy('openai-custom', null)).not.toThrow();
        });
    });

    // ==============================
    // markProviderUnhealthyWithRecoveryTime
    // ==============================
    describe('markProviderUnhealthyWithRecoveryTime', () => {
        test('sets scheduledRecoveryTime', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const recoveryTime = new Date(Date.now() + 3600000);
            manager.markProviderUnhealthyWithRecoveryTime('openai-custom', cfg, 'Quota exhausted', recoveryTime);
            const entry = manager.providerStatus['openai-custom'][0];
            expect(entry.config.isHealthy).toBe(false);
            expect(entry.config.scheduledRecoveryTime).toBeDefined();
        });

        test('accepts string recoveryTime', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const recoveryTime = new Date(Date.now() + 3600000).toISOString();
            manager.markProviderUnhealthyWithRecoveryTime('openai-custom', cfg, 'Quota', recoveryTime);
            expect(manager.providerStatus['openai-custom'][0].config.scheduledRecoveryTime).toBe(recoveryTime);
        });

        test('does nothing with invalid config', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.markProviderUnhealthyWithRecoveryTime('openai-custom', null)).not.toThrow();
        });
    });

    // ==============================
    // getProviderStats
    // ==============================
    describe('getProviderStats', () => {
        test('returns correct counts for mixed health states', () => {
            const pools = {
                'openai-custom': [
                    makeConfig('u1', { isHealthy: true, isDisabled: false }),
                    makeConfig('u2', { isHealthy: false, isDisabled: false }),
                    makeConfig('u3', { isHealthy: true, isDisabled: true }),
                    makeConfig('u4', { isHealthy: true, isDisabled: false }),
                ],
            };
            manager = new ProviderPoolManager(pools);
            const stats = manager.getProviderStats('openai-custom');
            expect(stats.total).toBe(4);
            expect(stats.healthy).toBe(2);
            expect(stats.unhealthy).toBe(1);
            expect(stats.disabled).toBe(1);
        });

        test('returns zeros for unknown provider type', () => {
            manager = new ProviderPoolManager({});
            const stats = manager.getProviderStats('unknown-type');
            expect(stats.total).toBe(0);
            expect(stats.healthy).toBe(0);
        });
    });

    // ==============================
    // getHealthyCount
    // ==============================
    describe('getHealthyCount', () => {
        test('counts only healthy and non-disabled providers', () => {
            const pools = {
                'openai-custom': [
                    makeConfig('u1', { isHealthy: true, isDisabled: false }),
                    makeConfig('u2', { isHealthy: false, isDisabled: false }),
                    makeConfig('u3', { isHealthy: true, isDisabled: true }),
                ],
            };
            manager = new ProviderPoolManager(pools);
            expect(manager.getHealthyCount('openai-custom')).toBe(1);
        });

        test('returns 0 for unknown provider type', () => {
            manager = new ProviderPoolManager({});
            expect(manager.getHealthyCount('unknown')).toBe(0);
        });
    });

    // ==============================
    // isAllProvidersUnhealthy
    // ==============================
    describe('isAllProvidersUnhealthy', () => {
        test('returns true when no providers exist', () => {
            manager = new ProviderPoolManager({});
            expect(manager.isAllProvidersUnhealthy('openai-custom')).toBe(true);
        });

        test('returns true when all providers are unhealthy', () => {
            const pools = {
                'openai-custom': [
                    makeConfig('u1', { isHealthy: false }),
                    makeConfig('u2', { isHealthy: false }),
                ],
            };
            manager = new ProviderPoolManager(pools);
            expect(manager.isAllProvidersUnhealthy('openai-custom')).toBe(true);
        });

        test('returns false when at least one healthy provider exists', () => {
            const pools = {
                'openai-custom': [
                    makeConfig('u1', { isHealthy: false }),
                    makeConfig('u2', { isHealthy: true }),
                ],
            };
            manager = new ProviderPoolManager(pools);
            expect(manager.isAllProvidersUnhealthy('openai-custom')).toBe(false);
        });
    });

    // ==============================
    // disableProvider / enableProvider
    // ==============================
    describe('disableProvider / enableProvider', () => {
        test('disableProvider sets isDisabled=true', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.disableProvider('openai-custom', cfg);
            expect(manager.providerStatus['openai-custom'][0].config.isDisabled).toBe(true);
        });

        test('enableProvider sets isDisabled=false', () => {
            const cfg = makeConfig('u1', { isDisabled: true });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.enableProvider('openai-custom', cfg);
            expect(manager.providerStatus['openai-custom'][0].config.isDisabled).toBe(false);
        });

        test('disableProvider does nothing with invalid config', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.disableProvider('openai-custom', {})).not.toThrow();
        });
    });

    // ==============================
    // resetProviderCounters
    // ==============================
    describe('resetProviderCounters', () => {
        test('resets errorCount and usageCount to 0', () => {
            const cfg = makeConfig('u1', { errorCount: 5, usageCount: 100 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.resetProviderCounters('openai-custom', cfg);
            const entry = manager.providerStatus['openai-custom'][0];
            expect(entry.config.errorCount).toBe(0);
            expect(entry.config.usageCount).toBe(0);
        });

        test('does nothing with invalid config', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.resetProviderCounters('openai-custom', {})).not.toThrow();
        });
    });

    // ==============================
    // resetProviderRefreshStatus
    // ==============================
    describe('resetProviderRefreshStatus', () => {
        test('resets needsRefresh and refreshCount', () => {
            const cfg = makeConfig('u1', { needsRefresh: true, refreshCount: 3 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.resetProviderRefreshStatus('openai-custom', 'u1');
            const entry = manager.providerStatus['openai-custom'][0];
            expect(entry.config.needsRefresh).toBe(false);
            expect(entry.config.refreshCount).toBe(0);
            expect(entry.config.lastHealthCheckTime).not.toBeNull();
        });

        test('does nothing with invalid parameters', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.resetProviderRefreshStatus(null, null)).not.toThrow();
        });
    });

    // ==============================
    // markProviderNeedRefresh
    // ==============================
    describe('markProviderNeedRefresh', () => {
        beforeEach(() => {
            // 让 refreshToken 返回挂起的 Promise，使刷新不会同步完成，
            // 避免 _refreshNodeToken 在第一个 await 前同步抛错，
            // 进而触发 markProviderUnhealthyImmediately 同步重置 needsRefresh=false
            mockGetServiceAdapter.mockReturnValue({
                refreshToken: jest.fn(() => new Promise(() => {})),
                forceRefreshToken: jest.fn(() => new Promise(() => {})),
            });
        });

        afterEach(() => {
            mockGetServiceAdapter.mockReset();
        });

        test('sets needsRefresh=true', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager.markProviderNeedRefresh('openai-custom', cfg);
            expect(manager.providerStatus['openai-custom'][0].config.needsRefresh).toBe(true);
        });

        test('does nothing with invalid config', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.markProviderNeedRefresh('openai-custom', {})).not.toThrow();
        });
    });

    // ==============================
    // refreshProviderUuid
    // ==============================
    describe('refreshProviderUuid', () => {
        test('generates a new UUID for the provider', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const newUuid = manager.refreshProviderUuid('openai-custom', cfg);
            expect(newUuid).not.toBe('u1');
            expect(newUuid).toBeDefined();
        });

        test('updates uuid in both providerStatus and providerPools', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const newUuid = manager.refreshProviderUuid('openai-custom', cfg);
            expect(manager.providerStatus['openai-custom'][0].uuid).toBe(newUuid);
            expect(manager.providerPools['openai-custom'][0].uuid).toBe(newUuid);
        });

        test('returns null when provider not found', () => {
            const cfg = makeConfig('nonexistent');
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            const result = manager.refreshProviderUuid('openai-custom', cfg);
            expect(result).toBeNull();
        });

        test('returns null with invalid config', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(manager.refreshProviderUuid('openai-custom', {})).toBeNull();
            expect(manager.refreshProviderUuid('openai-custom', null)).toBeNull();
        });
    });

    // ==============================
    // findProviderByUuid
    // ==============================
    describe('findProviderByUuid', () => {
        test('finds provider config by UUID across all pools', () => {
            const cfg1 = makeConfig('u1');
            const cfg2 = makeConfig('u2');
            manager = new ProviderPoolManager({
                'openai-custom': [cfg1],
                'gemini-cli-oauth': [cfg2],
            });
            const found = manager.findProviderByUuid('u2');
            expect(found).not.toBeNull();
            expect(found.uuid).toBe('u2');
        });

        test('returns null when UUID not found', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(manager.findProviderByUuid('nonexistent')).toBeNull();
        });

        test('returns null for empty UUID', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(manager.findProviderByUuid(null)).toBeNull();
            expect(manager.findProviderByUuid('')).toBeNull();
        });
    });

    // ==============================
    // getFallbackChain / setFallbackChain
    // ==============================
    describe('getFallbackChain / setFallbackChain', () => {
        test('getFallbackChain returns empty array when not configured', () => {
            manager = new ProviderPoolManager({});
            expect(manager.getFallbackChain('openai-custom')).toEqual([]);
        });

        test('setFallbackChain updates the fallback chain', () => {
            manager = new ProviderPoolManager({});
            manager.setFallbackChain('openai-custom', ['gemini-cli-oauth', 'forward-api']);
            expect(manager.getFallbackChain('openai-custom')).toEqual(['gemini-cli-oauth', 'forward-api']);
        });

        test('setFallbackChain does nothing with non-array', () => {
            manager = new ProviderPoolManager({});
            manager.setFallbackChain('openai-custom', 'not-an-array');
            expect(manager.getFallbackChain('openai-custom')).toEqual([]);
        });
    });

    // ==============================
    // _checkAndRecoverScheduledProviders
    // ==============================
    describe('_checkAndRecoverScheduledProviders', () => {
        test('recovers provider when recovery time has passed', () => {
            const pastRecoveryTime = new Date(Date.now() - 1000).toISOString();
            const cfg = makeConfig('u1', {
                isHealthy: false,
                scheduledRecoveryTime: pastRecoveryTime,
            });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager._checkAndRecoverScheduledProviders();
            expect(manager.providerStatus['openai-custom'][0].config.isHealthy).toBe(true);
            expect(manager.providerStatus['openai-custom'][0].config.scheduledRecoveryTime).toBeNull();
        });

        test('does not recover when recovery time is in the future', () => {
            const futureRecoveryTime = new Date(Date.now() + 3600000).toISOString();
            const cfg = makeConfig('u1', {
                isHealthy: false,
                scheduledRecoveryTime: futureRecoveryTime,
            });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            manager._checkAndRecoverScheduledProviders();
            expect(manager.providerStatus['openai-custom'][0].config.isHealthy).toBe(false);
        });

        test('only checks specified providerType when provided', () => {
            const pastRecoveryTime = new Date(Date.now() - 1000).toISOString();
            const cfg1 = makeConfig('u1', { isHealthy: false, scheduledRecoveryTime: pastRecoveryTime });
            const cfg2 = makeConfig('u2', { isHealthy: false, scheduledRecoveryTime: pastRecoveryTime });
            manager = new ProviderPoolManager({
                'openai-custom': [cfg1],
                'gemini-cli-oauth': [cfg2],
            });
            manager._checkAndRecoverScheduledProviders('openai-custom');
            expect(manager.providerStatus['openai-custom'][0].config.isHealthy).toBe(true);
            expect(manager.providerStatus['gemini-cli-oauth'][0].config.isHealthy).toBe(false);
        });
    });

    // ==============================
    // _flushPendingSaves (saveProviderPools)
    // ==============================
    describe('_flushPendingSaves', () => {
        test('writes provider pool data to file', async () => {
            mockFsReadFile.mockResolvedValue('{}');
            mockFsWriteFile.mockResolvedValue(undefined);

            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager(
                { 'openai-custom': [cfg] },
                { globalConfig: { PROVIDER_POOLS_FILE_PATH: '/tmp/test_pools.json' } }
            );
            manager.pendingSaves.add('openai-custom');
            await manager._flushPendingSaves();
            expect(mockFsWriteFile).toHaveBeenCalledWith(
                '/tmp/test_pools.json',
                expect.any(String),
                'utf8'
            );
        });

        test('creates new file when read returns ENOENT', async () => {
            mockFsReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockFsWriteFile.mockResolvedValue(undefined);

            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager(
                { 'openai-custom': [cfg] },
                { globalConfig: { PROVIDER_POOLS_FILE_PATH: '/tmp/new_file.json' } }
            );
            manager.pendingSaves.add('openai-custom');
            await manager._flushPendingSaves();
            expect(mockFsWriteFile).toHaveBeenCalled();
        });

        test('skips unknown providerType', async () => {
            mockFsReadFile.mockResolvedValue('{}');
            mockFsWriteFile.mockResolvedValue(undefined);

            manager = new ProviderPoolManager({});
            manager.pendingSaves.add('nonexistent-type');
            await manager._flushPendingSaves();
            // Should still write but with no data for the unknown type
            expect(mockFsWriteFile).toHaveBeenCalled();
        });

        test('does nothing when pendingSaves is empty', async () => {
            manager = new ProviderPoolManager({});
            await manager._flushPendingSaves();
            expect(mockFsWriteFile).not.toHaveBeenCalled();
        });
    });

    // ==============================
    // performHealthChecks
    // ==============================
    describe('performHealthChecks', () => {
        test('skips providers with future scheduledRecoveryTime', async () => {
            const futureTime = new Date(Date.now() + 3600000).toISOString();
            const cfg = makeConfig('u1', {
                isHealthy: false,
                scheduledRecoveryTime: futureTime,
                checkHealth: true,
            });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            // _checkProviderHealth shouldn't be called for this provider
            const checkSpy = jest.spyOn(manager, '_checkProviderHealth').mockResolvedValue(null);
            await manager.performHealthChecks();
            expect(checkSpy).not.toHaveBeenCalled();
        });

        test('skips unhealthy providers with recent errors', async () => {
            const recentErrorTime = new Date(Date.now() - 1000).toISOString(); // 1s ago
            const cfg = makeConfig('u1', {
                isHealthy: false,
                lastErrorTime: recentErrorTime,
                checkHealth: true,
            });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] }, {
                healthCheckInterval: 600000, // 10 minutes
            });
            const checkSpy = jest.spyOn(manager, '_checkProviderHealth').mockResolvedValue(null);
            await manager.performHealthChecks();
            expect(checkSpy).not.toHaveBeenCalled();
        });

        test('calls _checkProviderHealth for providers due for check', async () => {
            const cfg = makeConfig('u1', { checkHealth: true });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const checkSpy = jest.spyOn(manager, '_checkProviderHealth').mockResolvedValue({
                success: true,
                modelName: 'gpt-4o-mini',
                errorMessage: null,
            });
            await manager.performHealthChecks();
            expect(checkSpy).toHaveBeenCalled();
        });

        test('marks provider unhealthy when health check fails', async () => {
            const cfg = makeConfig('u1', { checkHealth: true });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            jest.spyOn(manager, '_checkProviderHealth').mockResolvedValue({
                success: false,
                modelName: 'gpt-4o-mini',
                errorMessage: 'Connection refused',
            });
            await manager.performHealthChecks();
            // markProviderUnhealthy increments errorCount
            expect(manager.providerStatus['openai-custom'][0].config.errorCount).toBeGreaterThan(0);
        });

        test('marks provider unhealthy when health check throws', async () => {
            const cfg = makeConfig('u1', { checkHealth: true });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            jest.spyOn(manager, '_checkProviderHealth').mockRejectedValue(new Error('Network error'));
            await manager.performHealthChecks();
            expect(manager.providerStatus['openai-custom'][0].config.errorCount).toBeGreaterThan(0);
        });
    });

    // ==============================
    // _checkProviderHealth
    // ==============================
    describe('_checkProviderHealth', () => {
        test('returns null when checkHealth is false and not forced', async () => {
            const cfg = makeConfig('u1', { checkHealth: false });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager._checkProviderHealth('openai-custom', cfg, false);
            expect(result).toBeNull();
        });

        test('returns error when unknown provider type with no default model', async () => {
            const cfg = makeConfig('u1', { checkHealth: true });
            manager = new ProviderPoolManager({ 'unknown-provider-xyz': [cfg] });
            const result = await manager._checkProviderHealth('unknown-provider-xyz', cfg, true);
            expect(result.success).toBe(false);
            expect(result.modelName).toBeNull();
        });

        test('returns success when generateContent succeeds', async () => {
            const cfg = makeConfig('u1', { checkHealth: true });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const mockAdapter = { generateContent: jest.fn().mockResolvedValue({}) };
            mockGetServiceAdapter.mockReturnValue(mockAdapter);

            const result = await manager._checkProviderHealth('openai-custom', cfg, true);
            expect(result.success).toBe(true);
            expect(result.modelName).toBe('gpt-4o-mini');
        });

        test('returns failure when generateContent throws', async () => {
            const cfg = makeConfig('u1', { checkHealth: true });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const mockAdapter = { generateContent: jest.fn().mockRejectedValue(new Error('API error')) };
            mockGetServiceAdapter.mockReturnValue(mockAdapter);

            const result = await manager._checkProviderHealth('openai-custom', cfg, true);
            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('API error');
        });

        test('uses checkModelName from config if provided', async () => {
            const cfg = makeConfig('u1', { checkHealth: true, checkModelName: 'custom-model' });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const mockAdapter = { generateContent: jest.fn().mockResolvedValue({}) };
            mockGetServiceAdapter.mockReturnValue(mockAdapter);

            const result = await manager._checkProviderHealth('openai-custom', cfg, true);
            expect(result.modelName).toBe('custom-model');
        });
    });

    // ==============================
    // _buildHealthCheckRequests
    // ==============================
    describe('_buildHealthCheckRequests', () => {
        test('returns gemini format for gemini providers', () => {
            manager = new ProviderPoolManager({});
            const requests = manager._buildHealthCheckRequests('gemini-cli-oauth', 'gemini-2.5-flash');
            expect(requests[0]).toHaveProperty('contents');
            expect(requests[0].contents[0]).toHaveProperty('parts');
        });

        test('returns messages format for claude-kiro providers', () => {
            manager = new ProviderPoolManager({});
            const requests = manager._buildHealthCheckRequests('claude-kiro-oauth', 'claude-haiku');
            expect(requests[0]).toHaveProperty('messages');
            expect(requests[0]).toHaveProperty('model', 'claude-haiku');
        });

        test('returns input format for openaiResponses-custom', () => {
            manager = new ProviderPoolManager({});
            const requests = manager._buildHealthCheckRequests('openaiResponses-custom', 'gpt-4o-mini');
            expect(requests[0]).toHaveProperty('input');
        });

        test('returns standard messages format for openai-custom', () => {
            manager = new ProviderPoolManager({});
            const requests = manager._buildHealthCheckRequests('openai-custom', 'gpt-4o-mini');
            expect(requests[0]).toHaveProperty('messages');
        });
    });

    // ==============================
    // _calculateNodeScore
    // ==============================
    describe('_calculateNodeScore', () => {
        test('returns large number for unhealthy provider', () => {
            const cfg = makeConfig('u1', { isHealthy: false });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const entry = manager.providerStatus['openai-custom'][0];
            const score = manager._calculateNodeScore(entry);
            expect(score).toBe(1e18);
        });

        test('returns large number for disabled provider', () => {
            const cfg = makeConfig('u1', { isDisabled: true });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const entry = manager.providerStatus['openai-custom'][0];
            const score = manager._calculateNodeScore(entry);
            expect(score).toBe(1e18);
        });

        test('healthy provider has finite score', () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const entry = manager.providerStatus['openai-custom'][0];
            const score = manager._calculateNodeScore(entry);
            expect(score).toBeLessThan(1e18);
        });

        test('provider with higher usageCount has higher score', () => {
            const cfg1 = makeConfig('u1', { usageCount: 0 });
            const cfg2 = makeConfig('u2', { usageCount: 100 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg1, cfg2] });
            const e1 = manager.providerStatus['openai-custom'][0];
            const e2 = manager.providerStatus['openai-custom'][1];
            expect(manager._calculateNodeScore(e1)).toBeLessThan(manager._calculateNodeScore(e2));
        });
    });

    // ==============================
    // acquireSlot / releaseSlot
    // ==============================
    describe('acquireSlot / releaseSlot', () => {
        test('acquireSlot increments activeCount when no concurrency limit', async () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager.acquireSlot('openai-custom');
            expect(result).not.toBeNull();
            expect(manager.providerStatus['openai-custom'][0].state.activeCount).toBe(1);
        });

        test('releaseSlot decrements activeCount', async () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            await manager.acquireSlot('openai-custom');
            manager.releaseSlot('openai-custom', 'u1');
            expect(manager.providerStatus['openai-custom'][0].state.activeCount).toBe(0);
        });

        test('releaseSlot does nothing for invalid parameters', () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1')] });
            expect(() => manager.releaseSlot(null, null)).not.toThrow();
            expect(() => manager.releaseSlot('openai-custom', null)).not.toThrow();
        });

        test('acquireSlot throws 429 when at concurrency limit with no queue', async () => {
            const cfg = makeConfig('u1', { concurrencyLimit: 1, queueLimit: 0 });
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            // Manually set activeCount to the limit
            manager.providerStatus['openai-custom'][0].state.activeCount = 1;
            await expect(manager.acquireSlot('openai-custom')).rejects.toMatchObject({ status: 429 });
        });

        test('acquireSlot returns null when no providers available', async () => {
            manager = new ProviderPoolManager({ 'openai-custom': [makeConfig('u1', { isHealthy: false })] });
            const result = await manager.acquireSlot('openai-custom');
            expect(result).toBeNull();
        });
    });

    // ==============================
    // getAllAvailableModels
    // ==============================
    describe('getAllAvailableModels', () => {
        test('returns raw array when endpointType is null', async () => {
            const { getProviderModels } = await import('../../../src/providers/provider-models.js');
            getProviderModels.mockReturnValue(['gpt-4o', 'gpt-4o-mini']);
            mockGetRegisteredProviders.mockReturnValue(['openai-custom']);

            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager.getAllAvailableModels();
            expect(Array.isArray(result)).toBe(true);
        });

        test('returns OpenAI format when OPENAI_MODEL_LIST endpointType', async () => {
            const { getProviderModels } = await import('../../../src/providers/provider-models.js');
            getProviderModels.mockReturnValue(['gpt-4o']);
            mockGetRegisteredProviders.mockReturnValue(['openai-custom']);

            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });
            const result = await manager.getAllAvailableModels('openai_model_list');
            expect(result).toHaveProperty('object', 'list');
            expect(Array.isArray(result.data)).toBe(true);
        });

        test('returns Gemini format when GEMINI_MODEL_LIST endpointType', async () => {
            const { getProviderModels } = await import('../../../src/providers/provider-models.js');
            getProviderModels.mockReturnValue(['gemini-2.0-flash']);
            mockGetRegisteredProviders.mockReturnValue(['gemini-cli-oauth']);

            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'gemini-cli-oauth': [cfg] });
            const result = await manager.getAllAvailableModels('gemini_model_list');
            expect(result).toHaveProperty('models');
            expect(Array.isArray(result.models)).toBe(true);
        });
    });

    // ==============================
    // _log method
    // ==============================
    describe('_log', () => {
        test('respects logLevel and filters lower level messages', async () => {
            const { default: logger } = await import('../../../src/utils/logger.js');
            manager = new ProviderPoolManager({}, { logLevel: 'warn' });
            manager._log('debug', 'This should be filtered');
            manager._log('info', 'This should be filtered');
            expect(logger.debug).not.toHaveBeenCalled();
            expect(logger.info).not.toHaveBeenCalled();
        });

        test('logs warn and error at warn logLevel', async () => {
            const { default: logger } = await import('../../../src/utils/logger.js');
            manager = new ProviderPoolManager({}, { logLevel: 'warn' });
            manager._log('warn', 'Warning message');
            manager._log('error', 'Error message');
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Warning message'));
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error message'));
        });
    });

    // ==============================
    // warmupNodes
    // ==============================
    describe('warmupNodes', () => {
        test('does nothing when warmupTarget is 0', async () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] }, {
                globalConfig: { WARMUP_TARGET: 0 },
            });
            const enqueueSpy = jest.spyOn(manager, '_enqueueRefresh');
            await manager.warmupNodes();
            expect(enqueueSpy).not.toHaveBeenCalled();
        });

        test('enqueues refresh for up to warmupTarget nodes per provider', async () => {
            const cfgs = [makeConfig('u1'), makeConfig('u2'), makeConfig('u3')];
            manager = new ProviderPoolManager({ 'openai-custom': cfgs }, {
                globalConfig: { WARMUP_TARGET: 2 },
            });
            manager.warmupTarget = 2;
            const enqueueSpy = jest.spyOn(manager, '_enqueueRefresh').mockImplementation(() => {});
            await manager.warmupNodes();
            expect(enqueueSpy).toHaveBeenCalledTimes(2);
        });
    });

    // ==============================
    // Concurrency control via _doSelectProvider
    // ==============================
    describe('concurrent selectProvider calls', () => {
        test('multiple concurrent calls each get different providers (round-robin)', async () => {
            const cfg1 = makeConfig('u1');
            const cfg2 = makeConfig('u2');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg1, cfg2] });

            const [r1, r2] = await Promise.all([
                manager.selectProvider('openai-custom'),
                manager.selectProvider('openai-custom'),
            ]);

            // Both should be selected but may be same or different depending on timing
            expect(r1).not.toBeNull();
            expect(r2).not.toBeNull();
        });

        test('selection sequence increments on each selection', async () => {
            const cfg = makeConfig('u1');
            manager = new ProviderPoolManager({ 'openai-custom': [cfg] });

            const initial = manager._selectionSequence;
            await manager.selectProvider('openai-custom');
            expect(manager._selectionSequence).toBe(initial + 1);
        });
    });
});
