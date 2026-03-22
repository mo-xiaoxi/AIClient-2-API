/**
 * Unit tests for services/usage-service.js
 *
 * Tests: UsageService class, getUsage(), getAllUsage(), getSupportedProviders(),
 *        formatKiroUsage(), formatGeminiUsage(), formatGrokUsage(),
 *        formatAntigravityUsage(), formatCodexUsage()
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let UsageService;
let usageService;
let formatKiroUsage;
let formatGeminiUsage;
let formatGrokUsage;
let formatAntigravityUsage;
let formatCodexUsage;

// Fixed object that we mutate between tests (ESM live binding works via mutation)
const mockServiceInstances = {};
let mockPoolManager = null;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        __esModule: true,
        getProviderPoolManager: jest.fn(() => mockPoolManager),
    }));

    await jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
        __esModule: true,
        serviceInstances: mockServiceInstances,
    }));

    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        __esModule: true,
        MODEL_PROVIDER: {
            KIRO_API: 'claude-kiro-oauth',
            GEMINI_CLI: 'gemini-cli-oauth',
            ANTIGRAVITY: 'gemini-antigravity',
            CODEX_API: 'openai-codex-oauth',
            GROK_CUSTOM: 'grok-custom',
        },
    }));

    const mod = await import('../../../src/services/usage-service.js');
    UsageService = mod.UsageService;
    usageService = mod.usageService;
    formatKiroUsage = mod.formatKiroUsage;
    formatGeminiUsage = mod.formatGeminiUsage;
    formatGrokUsage = mod.formatGrokUsage;
    formatAntigravityUsage = mod.formatAntigravityUsage;
    formatCodexUsage = mod.formatCodexUsage;
});

beforeEach(() => {
    // Clear the shared service instances object between tests
    for (const key of Object.keys(mockServiceInstances)) {
        delete mockServiceInstances[key];
    }
    mockPoolManager = null;
});

// =============================================================================
// UsageService — getSupportedProviders
// =============================================================================

describe('UsageService.getSupportedProviders()', () => {
    test('returns array of provider type strings', () => {
        const service = new UsageService();
        const providers = service.getSupportedProviders();
        expect(Array.isArray(providers)).toBe(true);
        expect(providers.length).toBeGreaterThan(0);
    });

    test('includes kiro provider', () => {
        const service = new UsageService();
        expect(service.getSupportedProviders()).toContain('claude-kiro-oauth');
    });

    test('includes gemini-cli provider', () => {
        const service = new UsageService();
        expect(service.getSupportedProviders()).toContain('gemini-cli-oauth');
    });
});

// =============================================================================
// UsageService — getUsage (single provider)
// =============================================================================

describe('UsageService.getUsage()', () => {
    test('throws for unsupported provider', async () => {
        const service = new UsageService();
        await expect(service.getUsage('unsupported-provider')).rejects.toThrow('不支持的提供商类型');
    });

    test('throws when service instance not found for kiro', async () => {
        // mockServiceInstances is already empty from beforeEach
        const service = new UsageService();
        await expect(service.getUsage('claude-kiro-oauth')).rejects.toThrow('Kiro 服务实例未找到');
    });

    test('calls getUsageLimits on the adapter when available', async () => {
        const mockUsage = { daysUntilReset: 5 };
        mockServiceInstances['claude-kiro-oauth'] = {
            getUsageLimits: jest.fn().mockResolvedValue(mockUsage),
        };
        const service = new UsageService();
        const result = await service.getUsage('claude-kiro-oauth');
        expect(result).toEqual(mockUsage);
    });

    test('throws when adapter exists but has no getUsageLimits', async () => {
        mockServiceInstances['claude-kiro-oauth'] = {}; // no getUsageLimits
        const service = new UsageService();
        await expect(service.getUsage('claude-kiro-oauth')).rejects.toThrow();
    });

    test('uses uuid to look up the correct service instance', async () => {
        const mockUsage = { daysUntilReset: 3 };
        mockServiceInstances['claude-kiro-oauthuuid-001'] = {
            getUsageLimits: jest.fn().mockResolvedValue(mockUsage),
        };
        const service = new UsageService();
        const result = await service.getUsage('claude-kiro-oauth', 'uuid-001');
        expect(result).toEqual(mockUsage);
    });
});

// =============================================================================
// UsageService — getAllUsage
// =============================================================================

describe('UsageService.getAllUsage()', () => {
    test('returns results object with keys for each provider', async () => {
        const makeAdapter = () => ({ getUsageLimits: jest.fn().mockResolvedValue({ data: 'ok' }) });
        mockServiceInstances['claude-kiro-oauth'] = makeAdapter();
        mockServiceInstances['gemini-cli-oauth'] = makeAdapter();
        mockServiceInstances['gemini-antigravity'] = makeAdapter();
        mockServiceInstances['openai-codex-oauth'] = makeAdapter();
        mockServiceInstances['grok-custom'] = makeAdapter();
        const service = new UsageService();
        const results = await service.getAllUsage();
        expect(typeof results).toBe('object');
        expect(Object.keys(results).length).toBeGreaterThan(0);
    });

    test('captures errors per provider without failing overall', async () => {
        // mockServiceInstances is already empty from beforeEach
        const service = new UsageService();
        const results = await service.getAllUsage();
        // Each provider should have an error entry
        for (const entries of Object.values(results)) {
            expect(Array.isArray(entries)).toBe(true);
            expect(entries[0].error).toBeDefined();
        }
    });

    test('uses pool manager when available', async () => {
        const mockUsage = { data: 'pool-usage' };
        const makeAdapter = () => ({ getUsageLimits: jest.fn().mockResolvedValue(mockUsage) });

        mockServiceInstances['claude-kiro-oauthuuid-pool-1'] = makeAdapter();
        mockServiceInstances['gemini-cli-oauthuuid-pool-1'] = makeAdapter();
        mockServiceInstances['gemini-antigravityuuid-pool-1'] = makeAdapter();
        mockServiceInstances['openai-codex-oauthuuid-pool-1'] = makeAdapter();
        mockServiceInstances['grok-customuuid-pool-1'] = makeAdapter();

        mockPoolManager = {
            getProviderPools: jest.fn().mockReturnValue([{ uuid: 'uuid-pool-1' }]),
        };

        const service = new UsageService();
        const results = await service.getAllUsage();
        expect(mockPoolManager.getProviderPools).toHaveBeenCalled();
        // Each provider should have pool entries
        for (const entries of Object.values(results)) {
            expect(Array.isArray(entries)).toBe(true);
        }
    });
});

// =============================================================================
// formatKiroUsage
// =============================================================================

describe('formatKiroUsage()', () => {
    test('returns null for null input', () => {
        expect(formatKiroUsage(null)).toBeNull();
    });

    test('returns object with usageBreakdown array', () => {
        const result = formatKiroUsage({});
        expect(Array.isArray(result.usageBreakdown)).toBe(true);
    });

    test('maps subscriptionInfo to subscription', () => {
        const result = formatKiroUsage({
            subscriptionInfo: { subscriptionTitle: 'Pro', type: 'pro' },
        });
        expect(result.subscription.title).toBe('Pro');
        expect(result.subscription.type).toBe('pro');
    });

    test('converts nextDateReset timestamp to ISO string', () => {
        const ts = Math.floor(Date.now() / 1000);
        const result = formatKiroUsage({ nextDateReset: ts });
        expect(result.nextDateReset).toBe(new Date(ts * 1000).toISOString());
    });

    test('maps usageBreakdownList items', () => {
        const result = formatKiroUsage({
            usageBreakdownList: [
                { resourceType: 'TOKENS', currentUsage: 10, usageLimit: 100 },
            ],
        });
        expect(result.usageBreakdown).toHaveLength(1);
        expect(result.usageBreakdown[0].resourceType).toBe('TOKENS');
    });

    test('maps userInfo to user', () => {
        const result = formatKiroUsage({
            userInfo: { email: 'user@example.com', userId: 'uid-1' },
        });
        expect(result.user.email).toBe('user@example.com');
        expect(result.user.userId).toBe('uid-1');
    });
});

// =============================================================================
// formatGeminiUsage
// =============================================================================

describe('formatGeminiUsage()', () => {
    test('returns null for null input', () => {
        expect(formatGeminiUsage(null)).toBeNull();
    });

    test('returns subscription with gemini-cli-oauth type', () => {
        const result = formatGeminiUsage({});
        expect(result.subscription.type).toBe('gemini-cli-oauth');
    });

    test('maps models to usageBreakdown items', () => {
        const result = formatGeminiUsage({
            models: {
                'gemini-pro:input': { remaining: 0.7 },
            },
        });
        expect(result.usageBreakdown).toHaveLength(1);
        expect(result.usageBreakdown[0].displayName).toContain('gemini-pro');
    });

    test('converts remaining to currentUsage percentage', () => {
        const result = formatGeminiUsage({
            models: {
                'test-model:output': { remaining: 0.6 },
            },
        });
        const item = result.usageBreakdown[0];
        expect(item.currentUsage).toBe(40); // 1 - 0.6 = 0.4 → 40%
        expect(item.usageLimit).toBe(100);
    });

    test('calculates daysUntilReset from quotaInfo', () => {
        const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000 * 5).toISOString();
        const result = formatGeminiUsage({
            quotaInfo: { quotaResetTime: futureDate },
        });
        expect(result.daysUntilReset).toBeGreaterThan(0);
    });
});

// =============================================================================
// formatGrokUsage
// =============================================================================

describe('formatGrokUsage()', () => {
    test('returns null for null input', () => {
        expect(formatGrokUsage(null)).toBeNull();
    });

    test('returns subscription with grok-custom type', () => {
        const result = formatGrokUsage({});
        expect(result.subscription.type).toBe('grok-custom');
    });

    test('maps totalLimit and usedQueries to usageBreakdown', () => {
        const result = formatGrokUsage({
            totalLimit: 1000,
            usedQueries: 200,
            unit: 'queries',
        });
        expect(result.usageBreakdown).toHaveLength(1);
        const item = result.usageBreakdown[0];
        expect(item.usageLimit).toBe(1000);
        expect(item.currentUsage).toBe(200);
    });

    test('handles remainingTokens-only structure', () => {
        const result = formatGrokUsage({ remainingTokens: 5000 });
        expect(result.usageBreakdown).toHaveLength(1);
        expect(result.usageBreakdown[0].usageLimit).toBe(5000);
    });

    test('returns empty usageBreakdown for empty input', () => {
        const result = formatGrokUsage({});
        expect(result.usageBreakdown).toHaveLength(0);
    });
});

// =============================================================================
// formatCodexUsage
// =============================================================================

describe('formatCodexUsage()', () => {
    test('returns null for null input', () => {
        expect(formatCodexUsage(null)).toBeNull();
    });

    test('returns subscription with openai-codex-oauth type', () => {
        const result = formatCodexUsage({});
        expect(result.subscription.type).toBe('openai-codex-oauth');
    });

    test('maps models to usageBreakdown items', () => {
        const result = formatCodexUsage({
            models: {
                'codex-mini': { remaining: 0.8 },
            },
        });
        expect(result.usageBreakdown).toHaveLength(1);
        expect(result.usageBreakdown[0].currentUsage).toBe(20); // (1-0.8)*100
    });

    test('extracts nextDateReset from raw.rateLimit', () => {
        const ts = Math.floor(Date.now() / 1000);
        const result = formatCodexUsage({
            raw: { rateLimit: { primaryWindow: { resetAt: ts } } },
        });
        expect(result.nextDateReset).toBe(new Date(ts * 1000).toISOString());
    });
});
