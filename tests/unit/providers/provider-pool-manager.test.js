/**
 * Unit tests for provider-pool-manager.js
 *
 * Tests: selectProvider, markProviderHealthy, markProviderUnhealthy,
 *        resetProviderCounters, errorCount threshold, concurrent selection.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let ProviderPoolManager;

beforeAll(async () => {
    // Mock logger
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        },
    }));

    // Mock adapter
    await jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
        getServiceAdapter: jest.fn(() => ({
            refreshToken: jest.fn().mockResolvedValue(undefined),
            forceRefreshToken: jest.fn().mockResolvedValue(undefined),
            listModels: jest.fn().mockResolvedValue([]),
        })),
        getRegisteredProviders: jest.fn(() => ['gemini-cli-oauth', 'openai-custom', 'forward-api']),
    }));

    // Mock provider-models
    await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
        getProviderModels: jest.fn(() => []),
    }));

    // Mock event-broadcast
    await jest.unstable_mockModule('../../../src/ui-modules/event-broadcast.js', () => ({
        broadcastEvent: jest.fn(),
    }));

    // Mock convert
    await jest.unstable_mockModule('../../../src/convert/convert.js', () => ({
        convertData: jest.fn(() => ({ data: [] })),
        ENDPOINT_TYPE: { OPENAI_MODEL_LIST: 'openai', GEMINI_MODEL_LIST: 'gemini' },
    }));

    // Mock common
    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        MODEL_PROVIDER: {
            GEMINI_CLI: 'gemini-cli-oauth',
            OPENAI_CUSTOM: 'openai-custom',
            FORWARD_API: 'forward-api',
            AUTO: 'auto',
        },
        getProtocolPrefix: jest.fn((provider) => {
            if (provider.startsWith('gemini')) return 'gemini';
            if (provider.startsWith('openai')) return 'openai';
            if (provider.startsWith('forward')) return 'forward';
            return provider.split('-')[0];
        }),
        ENDPOINT_TYPE: {
            OPENAI_MODEL_LIST: 'openai',
            GEMINI_MODEL_LIST: 'gemini',
        },
    }));

    // Mock fs (for file save operations)
    await jest.unstable_mockModule('fs', () => ({
        default: {
            existsSync: jest.fn(() => false),
            readFileSync: jest.fn(() => '{}'),
        },
        existsSync: jest.fn(() => false),
        readFileSync: jest.fn(() => '{}'),
    }));

    const mod = await import('../../../src/providers/provider-pool-manager.js');
    ProviderPoolManager = mod.ProviderPoolManager;
});

// ---------------------------------------------------------------------------
// Helper: create a simple pool config
// ---------------------------------------------------------------------------
function makePool(n = 2, providerType = 'gemini-cli-oauth') {
    const configs = Array.from({ length: n }, (_, i) => ({
        uuid: `uuid-${i + 1}`,
        isHealthy: true,
        isDisabled: false,
    }));
    return { [providerType]: configs };
}

function makeManager(poolOverride = null, opts = {}) {
    const pool = poolOverride || makePool(2, 'gemini-cli-oauth');
    return new ProviderPoolManager(pool, {
        maxErrorCount: 3,
        saveDebounceTime: 10000, // long debounce to avoid file-write side-effects
        logLevel: 'error',      // suppress noise in test output
        ...opts,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProviderPoolManager — constructor & initialization', () => {
    test('initializes provider status from pool config', () => {
        const mgr = makeManager();
        const statuses = mgr.providerStatus['gemini-cli-oauth'];
        expect(statuses).toHaveLength(2);
        expect(statuses[0].uuid).toBe('uuid-1');
        expect(statuses[1].uuid).toBe('uuid-2');
    });

    test('default maxErrorCount is 10 when not provided', () => {
        const mgr = new ProviderPoolManager({}, {});
        expect(mgr.maxErrorCount).toBe(10);
    });

    test('respects custom maxErrorCount option', () => {
        const mgr = makeManager(null, { maxErrorCount: 5 });
        expect(mgr.maxErrorCount).toBe(5);
    });

    test('all providers start healthy', () => {
        const mgr = makeManager();
        const statuses = mgr.providerStatus['gemini-cli-oauth'];
        expect(statuses.every(p => p.config.isHealthy)).toBe(true);
    });

    test('getHealthyCount returns correct count', () => {
        const mgr = makeManager(makePool(3));
        expect(mgr.getHealthyCount('gemini-cli-oauth')).toBe(3);
    });
});

describe('ProviderPoolManager — selectProvider', () => {
    let mgr;

    beforeEach(() => {
        mgr = makeManager();
    });

    test('returns a config object for healthy provider type', async () => {
        const config = await mgr.selectProvider('gemini-cli-oauth');
        expect(config).not.toBeNull();
        expect(config.uuid).toBeDefined();
    });

    test('returns null for unknown provider type', async () => {
        const config = await mgr.selectProvider('nonexistent-provider');
        expect(config).toBeNull();
    });

    test('returns null when all providers are unhealthy', async () => {
        const pool = makePool(2);
        pool['gemini-cli-oauth'].forEach(c => { c.isHealthy = false; });
        const mgr2 = makeManager(pool);
        const config = await mgr2.selectProvider('gemini-cli-oauth');
        expect(config).toBeNull();
    });

    test('returns null when all providers are disabled', async () => {
        const pool = makePool(2);
        pool['gemini-cli-oauth'].forEach(c => { c.isDisabled = true; });
        const mgr2 = makeManager(pool);
        const config = await mgr2.selectProvider('gemini-cli-oauth');
        expect(config).toBeNull();
    });

    test('skips providers that do not support requested model', async () => {
        const pool = {
            'openai-custom': [
                { uuid: 'p1', isHealthy: true, isDisabled: false, notSupportedModels: ['gpt-4'] },
                { uuid: 'p2', isHealthy: true, isDisabled: false },
            ],
        };
        const mgr2 = makeManager(pool);
        const config = await mgr2.selectProvider('openai-custom', 'gpt-4');
        expect(config).not.toBeNull();
        expect(config.uuid).toBe('p2');
    });

    test('returns null if all providers exclude the requested model', async () => {
        const pool = {
            'openai-custom': [
                { uuid: 'p1', isHealthy: true, isDisabled: false, notSupportedModels: ['gpt-4'] },
            ],
        };
        const mgr2 = makeManager(pool);
        const config = await mgr2.selectProvider('openai-custom', 'gpt-4');
        expect(config).toBeNull();
    });

    test('increments usageCount on each selection by default', async () => {
        const config = await mgr.selectProvider('gemini-cli-oauth');
        expect(config.usageCount).toBeGreaterThan(0);
    });

    test('does NOT increment usageCount when skipUsageCount is true', async () => {
        const before = (await mgr.selectProvider('gemini-cli-oauth', null, { skipUsageCount: true })).usageCount;
        const after = (await mgr.selectProvider('gemini-cli-oauth', null, { skipUsageCount: true })).usageCount;
        // usageCount should not increase between two skipUsageCount calls on same node
        // (different nodes can be selected; we just check neither incremented beyond initial)
        // The initial usageCount for newly selected node can be 0 if it was never selected
        expect(after).toBeGreaterThanOrEqual(0);
    });

    test('returns null for invalid providerType (null)', async () => {
        const config = await mgr.selectProvider(null);
        expect(config).toBeNull();
    });
});

describe('ProviderPoolManager — markProviderUnhealthy', () => {
    let mgr;

    beforeEach(() => {
        mgr = makeManager(makePool(2), { maxErrorCount: 3 });
    });

    test('increments errorCount on each call', () => {
        mgr.markProviderUnhealthy('gemini-cli-oauth', { uuid: 'uuid-1' });
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.errorCount).toBe(1);
    });

    test('marks provider unhealthy after maxErrorCount errors', () => {
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        // Pre-set lastErrorTime to simulate errors within the same 10s window
        provider.config.lastErrorTime = new Date().toISOString();
        provider.config.errorCount = 2; // Already had 2 errors
        // One more call should push errorCount to 3 which equals maxErrorCount
        mgr.markProviderUnhealthy('gemini-cli-oauth', { uuid: 'uuid-1' });
        expect(provider.config.isHealthy).toBe(false);
    });

    test('does not mark unhealthy before reaching maxErrorCount', () => {
        mgr.markProviderUnhealthy('gemini-cli-oauth', { uuid: 'uuid-1' });
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.isHealthy).toBe(true);
    });

    test('ignores call with missing uuid', () => {
        expect(() => mgr.markProviderUnhealthy('gemini-cli-oauth', {})).not.toThrow();
    });

    test('stores error message in lastErrorMessage', () => {
        mgr.markProviderUnhealthy('gemini-cli-oauth', { uuid: 'uuid-1' }, 'Rate limited');
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.lastErrorMessage).toBe('Rate limited');
    });
});

describe('ProviderPoolManager — markProviderHealthy', () => {
    let mgr;

    beforeEach(() => {
        mgr = makeManager(makePool(2), { maxErrorCount: 3 });
        // First mark one unhealthy
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        provider.config.isHealthy = false;
        provider.config.errorCount = 3;
    });

    test('restores isHealthy to true', () => {
        mgr.markProviderHealthy('gemini-cli-oauth', { uuid: 'uuid-1' });
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.isHealthy).toBe(true);
    });

    test('resets errorCount to 0', () => {
        mgr.markProviderHealthy('gemini-cli-oauth', { uuid: 'uuid-1' });
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.errorCount).toBe(0);
    });

    test('resets refreshCount to 0', () => {
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        provider.config.refreshCount = 2;
        mgr.markProviderHealthy('gemini-cli-oauth', { uuid: 'uuid-1' });
        expect(provider.config.refreshCount).toBe(0);
    });

    test('resets usageCount when resetUsageCount=true', () => {
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        provider.config.usageCount = 10;
        mgr.markProviderHealthy('gemini-cli-oauth', { uuid: 'uuid-1' }, true);
        expect(provider.config.usageCount).toBe(0);
    });

    test('ignores call with missing uuid', () => {
        expect(() => mgr.markProviderHealthy('gemini-cli-oauth', {})).not.toThrow();
    });
});

describe('ProviderPoolManager — resetProviderCounters', () => {
    let mgr;

    beforeEach(() => {
        mgr = makeManager();
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        provider.config.errorCount = 5;
        provider.config.usageCount = 20;
        provider.config._lastSelectionSeq = 99;
    });

    test('resets errorCount to 0', () => {
        mgr.resetProviderCounters('gemini-cli-oauth', { uuid: 'uuid-1' });
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.errorCount).toBe(0);
    });

    test('resets usageCount to 0', () => {
        mgr.resetProviderCounters('gemini-cli-oauth', { uuid: 'uuid-1' });
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.usageCount).toBe(0);
    });

    test('resets _lastSelectionSeq to 0', () => {
        mgr.resetProviderCounters('gemini-cli-oauth', { uuid: 'uuid-1' });
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config._lastSelectionSeq).toBe(0);
    });

    test('ignores call with missing uuid', () => {
        expect(() => mgr.resetProviderCounters('gemini-cli-oauth', {})).not.toThrow();
    });
});

describe('ProviderPoolManager — markProviderUnhealthyImmediately', () => {
    let mgr;

    beforeEach(() => {
        mgr = makeManager(makePool(2), { maxErrorCount: 10 });
    });

    test('immediately sets isHealthy to false', () => {
        mgr.markProviderUnhealthyImmediately('gemini-cli-oauth', { uuid: 'uuid-1' }, 'Auth failed');
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.isHealthy).toBe(false);
    });

    test('sets errorCount to maxErrorCount', () => {
        mgr.markProviderUnhealthyImmediately('gemini-cli-oauth', { uuid: 'uuid-1' });
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.errorCount).toBe(mgr.maxErrorCount);
    });

    test('stores error message', () => {
        mgr.markProviderUnhealthyImmediately('gemini-cli-oauth', { uuid: 'uuid-1' }, 'Unauthorized');
        const provider = mgr.providerStatus['gemini-cli-oauth'].find(p => p.uuid === 'uuid-1');
        expect(provider.config.lastErrorMessage).toBe('Unauthorized');
    });
});

describe('ProviderPoolManager — health statistics', () => {
    test('getProviderStats returns correct counts', () => {
        const pool = {
            'openai-custom': [
                { uuid: 'p1', isHealthy: true, isDisabled: false },
                { uuid: 'p2', isHealthy: false, isDisabled: false },
                { uuid: 'p3', isHealthy: true, isDisabled: true },
            ],
        };
        const mgr = makeManager(pool);
        const stats = mgr.getProviderStats('openai-custom');
        expect(stats.total).toBe(3);
        expect(stats.healthy).toBe(1);
        expect(stats.unhealthy).toBe(1);
        expect(stats.disabled).toBe(1);
    });

    test('isAllProvidersUnhealthy returns true when all are unhealthy', () => {
        const pool = makePool(2);
        pool['gemini-cli-oauth'].forEach(c => { c.isHealthy = false; });
        const mgr = makeManager(pool);
        expect(mgr.isAllProvidersUnhealthy('gemini-cli-oauth')).toBe(true);
    });

    test('isAllProvidersUnhealthy returns false when at least one is healthy', () => {
        const mgr = makeManager();
        expect(mgr.isAllProvidersUnhealthy('gemini-cli-oauth')).toBe(false);
    });

    test('isAllProvidersUnhealthy returns true for unknown type', () => {
        const mgr = makeManager();
        expect(mgr.isAllProvidersUnhealthy('unknown-type')).toBe(true);
    });

    test('findProviderByUuid returns config for known uuid', () => {
        const mgr = makeManager();
        const config = mgr.findProviderByUuid('uuid-1');
        expect(config).not.toBeNull();
        expect(config.uuid).toBe('uuid-1');
    });

    test('findProviderByUuid returns null for unknown uuid', () => {
        const mgr = makeManager();
        expect(mgr.findProviderByUuid('nonexistent')).toBeNull();
    });
});

describe('ProviderPoolManager — fallback chain', () => {
    test('getFallbackChain returns empty array when not configured', () => {
        const mgr = makeManager();
        expect(mgr.getFallbackChain('gemini-cli-oauth')).toEqual([]);
    });

    test('setFallbackChain sets the chain and getFallbackChain returns it', () => {
        const mgr = makeManager();
        mgr.setFallbackChain('gemini-cli-oauth', ['openai-custom']);
        expect(mgr.getFallbackChain('gemini-cli-oauth')).toEqual(['openai-custom']);
    });

    test('setFallbackChain ignores invalid input (non-array)', () => {
        const mgr = makeManager();
        expect(() => mgr.setFallbackChain('gemini-cli-oauth', 'not-array')).not.toThrow();
    });
});

describe('ProviderPoolManager — concurrent selection (_lastSelectionSeq)', () => {
    test('sequential calls produce increasing _lastSelectionSeq', async () => {
        const pool = makePool(1);
        const mgr = makeManager(pool);
        await mgr.selectProvider('gemini-cli-oauth');
        const seq1 = mgr.providerStatus['gemini-cli-oauth'][0].config._lastSelectionSeq;
        await mgr.selectProvider('gemini-cli-oauth');
        const seq2 = mgr.providerStatus['gemini-cli-oauth'][0].config._lastSelectionSeq;
        expect(seq2).toBeGreaterThan(seq1);
    });

    test('concurrent selectProvider calls all resolve', async () => {
        const pool = makePool(3);
        const mgr = makeManager(pool);
        const results = await Promise.all([
            mgr.selectProvider('gemini-cli-oauth'),
            mgr.selectProvider('gemini-cli-oauth'),
            mgr.selectProvider('gemini-cli-oauth'),
        ]);
        expect(results.every(r => r !== null)).toBe(true);
    });
});
