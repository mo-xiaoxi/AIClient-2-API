/**
 * UI Module: usage-api.js Tests
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
    default: {},
    initTlsSidecar: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
    CONFIG: { MODEL_PROVIDER: 'gemini-cli-oauth' },
}));

jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
    serviceInstances: {},
    getServiceAdapter: jest.fn(() => null),
}));

jest.unstable_mockModule('../../../src/services/usage-service.js', () => ({
    formatKiroUsage: jest.fn(d => d),
    formatGeminiUsage: jest.fn(d => d),
    formatAntigravityUsage: jest.fn(d => d),
    formatCodexUsage: jest.fn(d => d),
    formatGrokUsage: jest.fn(d => d),
}));

jest.unstable_mockModule('../../../src/ui-modules/usage-cache.js', () => ({
    readUsageCache: jest.fn().mockResolvedValue(null),
    writeUsageCache: jest.fn().mockResolvedValue(undefined),
    readProviderUsageCache: jest.fn().mockResolvedValue(null),
    updateProviderUsageCache: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../../src/utils/provider-utils.js', () => ({
    PROVIDER_MAPPINGS: [],
}));

function createMockRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
    };
}

function createMockReq(url = 'http://localhost/api/usage') {
    return {
        url,
        headers: { host: 'localhost' },
    };
}

let handleGetSupportedProviders;
let handleGetUsage;
let handleGetProviderUsage;

beforeAll(async () => {
    ({ handleGetSupportedProviders, handleGetUsage, handleGetProviderUsage } =
        await import('../../../src/ui-modules/usage-api.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('usage-api.js - handleGetSupportedProviders', () => {
    test('returns 200 with supported provider list', async () => {
        const req = createMockReq();
        const res = createMockRes();
        await handleGetSupportedProviders(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(Array.isArray(body)).toBe(true);
        // Should include common providers
        expect(body).toContain('gemini-cli-oauth');
        expect(body).toContain('claude-kiro-oauth');
    });

    test('returns 500 when res.end throws', async () => {
        const req = createMockReq();
        const res = createMockRes();
        res.end.mockImplementationOnce(() => { throw new Error('connection reset'); });
        await handleGetSupportedProviders(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});

describe('usage-api.js - handleGetUsage', () => {
    test('returns 200 with usage data (empty pools)', async () => {
        const req = createMockReq('http://localhost/api/usage');
        const res = createMockRes();
        const currentConfig = { providerPools: {} };
        const providerPoolManager = null;
        await handleGetUsage(req, res, currentConfig, providerPoolManager);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body).toHaveProperty('serverTime');
        expect(body).toHaveProperty('providers');
    });

    test('returns cached data when cache exists', async () => {
        const { readUsageCache } = await import('../../../src/ui-modules/usage-cache.js');
        readUsageCache.mockResolvedValueOnce({
            timestamp: new Date().toISOString(),
            providers: { 'gemini-cli-oauth': { success: true } },
        });

        const req = createMockReq('http://localhost/api/usage');
        const res = createMockRes();
        await handleGetUsage(req, res, {}, null);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.fromCache).toBe(true);
        expect(body.providers['gemini-cli-oauth']).toBeDefined();
    });

    test('forces refresh when refresh=true query param', async () => {
        const { readUsageCache, writeUsageCache } = await import('../../../src/ui-modules/usage-cache.js');
        readUsageCache.mockResolvedValue({
            timestamp: new Date().toISOString(),
            providers: {},
        });

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        await handleGetUsage(req, res, {}, null);
        // Even though cache exists, refresh=true bypasses it
        // readUsageCache should not be called for actual usage retrieval
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    test('returns 500 when writeUsageCache fails after fresh fetch', async () => {
        const { readUsageCache, writeUsageCache } = await import('../../../src/ui-modules/usage-cache.js');
        readUsageCache.mockResolvedValueOnce(null);
        writeUsageCache.mockRejectedValueOnce(new Error('disk full'));
        const req = createMockReq('http://localhost/api/usage');
        const res = createMockRes();
        await handleGetUsage(req, res, {}, null);
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('disk full');
    });

    test('uses currentConfig.providerPools when providerPoolManager is null', async () => {
        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                'gemini-cli-oauth': [{ uuid: 'cfg-uuid', isDisabled: false }],
            },
        };
        await handleGetUsage(req, res, currentConfig, null);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.providers['gemini-cli-oauth']).toBeDefined();
    });

    test('skips disabled provider instances', async () => {
        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': [{ uuid: 'disabled-uuid', isDisabled: true }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const geminiData = body.providers['gemini-cli-oauth'];
        expect(geminiData.instances[0].error).toBe('Provider is disabled');
    });

    test('fetches usage when adapter exists in serviceInstances (gemini)', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        const { formatGeminiUsage } = await import('../../../src/services/usage-service.js');
        formatGeminiUsage.mockReturnValueOnce({ usageBreakdown: [{ model: 'gemini-2.0-flash' }] });

        serviceInstances['gemini-cli-oauthgemini-test'] = {
            getUsageLimits: jest.fn().mockResolvedValue({ limits: [] }),
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': [{ uuid: 'gemini-test' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const instance = body.providers['gemini-cli-oauth'].instances[0];
        expect(instance.success).toBe(true);

        delete serviceInstances['gemini-cli-oauthgemini-test'];
    });

    test('auto-initializes adapter when not in serviceInstances (kiro)', async () => {
        const { getServiceAdapter } = await import('../../../src/providers/adapter.js');
        const { formatKiroUsage } = await import('../../../src/services/usage-service.js');

        const mockAdapter = { getUsageLimits: jest.fn().mockResolvedValue({ tokens: 100 }) };
        getServiceAdapter.mockReturnValueOnce(mockAdapter);
        formatKiroUsage.mockReturnValueOnce({ usageBreakdown: [] });

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'claude-kiro-oauth': [{ uuid: 'new-kiro-uuid' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const instance = body.providers['claude-kiro-oauth'].instances[0];
        expect(instance.success).toBe(true);
    });

    test('handles getUsageLimits error gracefully', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        serviceInstances['claude-kiro-oautherr-kiro'] = {
            getUsageLimits: jest.fn().mockRejectedValue(new Error('Usage API unavailable')),
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'claude-kiro-oauth': [{ uuid: 'err-kiro' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const instance = body.providers['claude-kiro-oauth'].instances[0];
        expect(instance.error).toContain('Usage API unavailable');

        delete serviceInstances['claude-kiro-oautherr-kiro'];
    });

    test('fetches cursor-oauth usage (no usage API, returns unsupported flag)', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        serviceInstances['cursor-oauthcursor-1'] = { someMethod: jest.fn() };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'cursor-oauth': [{ uuid: 'cursor-1' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const instance = body.providers['cursor-oauth'].instances[0];
        expect(instance.usage).toHaveProperty('unsupported', true);

        delete serviceInstances['cursor-oauthcursor-1'];
    });

    test('getAdapterUsage throws for grok without getUsageLimits', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        // Adapter without getUsageLimits → should throw
        serviceInstances['grok-customgrok-1'] = {};

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'grok-custom': [{ uuid: 'grok-1' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const instance = body.providers['grok-custom'].instances[0];
        expect(instance.error).toBeDefined();

        delete serviceInstances['grok-customgrok-1'];
    });

    test('fetches antigravity usage', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        const { formatAntigravityUsage } = await import('../../../src/services/usage-service.js');
        formatAntigravityUsage.mockReturnValueOnce({ usageBreakdown: [] });
        serviceInstances['gemini-antigravityanti-1'] = {
            getUsageLimits: jest.fn().mockResolvedValue({ models: {} }),
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'gemini-antigravity': [{ uuid: 'anti-1' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.providers['gemini-antigravity'].instances[0].success).toBe(true);

        delete serviceInstances['gemini-antigravityanti-1'];
    });

    test('fetches codex usage', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        const { formatCodexUsage } = await import('../../../src/services/usage-service.js');
        formatCodexUsage.mockReturnValueOnce({ usageBreakdown: [] });
        serviceInstances['openai-codex-oauthcodex-1'] = {
            getUsageLimits: jest.fn().mockResolvedValue({ snapshots: [] }),
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'openai-codex-oauth': [{ uuid: 'codex-1' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.providers['openai-codex-oauth'].instances[0].success).toBe(true);

        delete serviceInstances['openai-codex-oauthcodex-1'];
    });

    test('fetches grok usage with getUsageLimits', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        const { formatGrokUsage } = await import('../../../src/services/usage-service.js');
        formatGrokUsage.mockReturnValueOnce({ usageBreakdown: [] });
        serviceInstances['grok-customgrok-ok'] = {
            getUsageLimits: jest.fn().mockResolvedValue({ subscription: {} }),
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'grok-custom': [{ uuid: 'grok-ok' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.providers['grok-custom'].instances[0].success).toBe(true);

        delete serviceInstances['grok-customgrok-ok'];
    });

    test('provider with customName uses it as display name', async () => {
        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': [{ uuid: 'u1', customName: 'My Gemini Account' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const instance = body.providers['gemini-cli-oauth'].instances[0];
        expect(instance.name).toBe('My Gemini Account');
    });

    test('records init error when getServiceAdapter throws', async () => {
        const { getServiceAdapter } = await import('../../../src/providers/adapter.js');
        getServiceAdapter.mockImplementationOnce(() => { throw new Error('factory error'); });

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': [{ uuid: 'failing-init' }],
            },
        };
        await handleGetUsage(req, res, {}, providerPoolManager);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const instance = body.providers['gemini-cli-oauth'].instances[0];
        expect(instance.error).toContain('factory error');
    });

    test('uses kiroApiService.getUsageLimits when adapter has no direct getUsageLimits', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        const { formatKiroUsage } = await import('../../../src/services/usage-service.js');
        formatKiroUsage.mockReturnValueOnce({ usageBreakdown: [] });

        serviceInstances['claude-kiro-oauthkiro-sub'] = {
            kiroApiService: { getUsageLimits: jest.fn().mockResolvedValue({ limits: [] }) },
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        await handleGetUsage(req, res, {}, {
            providerPools: { 'claude-kiro-oauth': [{ uuid: 'kiro-sub' }] },
        });
        const instance = JSON.parse(res.end.mock.calls[0][0]).providers['claude-kiro-oauth'].instances[0];
        expect(instance.success).toBe(true);

        delete serviceInstances['claude-kiro-oauthkiro-sub'];
    });

    test('throws when kiro adapter has neither getUsageLimits nor kiroApiService', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        serviceInstances['claude-kiro-oauthkiro-none'] = {};

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        await handleGetUsage(req, res, {}, {
            providerPools: { 'claude-kiro-oauth': [{ uuid: 'kiro-none' }] },
        });
        const instance = JSON.parse(res.end.mock.calls[0][0]).providers['claude-kiro-oauth'].instances[0];
        expect(instance.error).toBeDefined();

        delete serviceInstances['claude-kiro-oauthkiro-none'];
    });

    test('uses geminiApiService.getUsageLimits when adapter has no direct getUsageLimits', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        const { formatGeminiUsage } = await import('../../../src/services/usage-service.js');
        formatGeminiUsage.mockReturnValueOnce({ usageBreakdown: [] });

        serviceInstances['gemini-cli-oauthgemini-sub'] = {
            geminiApiService: { getUsageLimits: jest.fn().mockResolvedValue({ quota: [] }) },
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        await handleGetUsage(req, res, {}, {
            providerPools: { 'gemini-cli-oauth': [{ uuid: 'gemini-sub' }] },
        });
        const instance = JSON.parse(res.end.mock.calls[0][0]).providers['gemini-cli-oauth'].instances[0];
        expect(instance.success).toBe(true);

        delete serviceInstances['gemini-cli-oauthgemini-sub'];
    });

    test('uses antigravityApiService.getUsageLimits when adapter has no direct getUsageLimits', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        const { formatAntigravityUsage } = await import('../../../src/services/usage-service.js');
        formatAntigravityUsage.mockReturnValueOnce({ usageBreakdown: [] });

        serviceInstances['gemini-antigravityanti-sub'] = {
            antigravityApiService: { getUsageLimits: jest.fn().mockResolvedValue({ models: {} }) },
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        await handleGetUsage(req, res, {}, {
            providerPools: { 'gemini-antigravity': [{ uuid: 'anti-sub' }] },
        });
        const instance = JSON.parse(res.end.mock.calls[0][0]).providers['gemini-antigravity'].instances[0];
        expect(instance.success).toBe(true);

        delete serviceInstances['gemini-antigravityanti-sub'];
    });

    test('uses codexApiService.getUsageLimits when adapter has no direct getUsageLimits', async () => {
        const { serviceInstances } = await import('../../../src/providers/adapter.js');
        const { formatCodexUsage } = await import('../../../src/services/usage-service.js');
        formatCodexUsage.mockReturnValueOnce({ usageBreakdown: [] });

        serviceInstances['openai-codex-oauthcodex-sub'] = {
            codexApiService: { getUsageLimits: jest.fn().mockResolvedValue({ snapshots: [] }) },
        };

        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        await handleGetUsage(req, res, {}, {
            providerPools: { 'openai-codex-oauth': [{ uuid: 'codex-sub' }] },
        });
        const instance = JSON.parse(res.end.mock.calls[0][0]).providers['openai-codex-oauth'].instances[0];
        expect(instance.success).toBe(true);

        delete serviceInstances['openai-codex-oauthcodex-sub'];
    });

    test('display name falls back to "Unnamed" when provider has no uuid, customName, or credKey', async () => {
        const req = createMockReq('http://localhost/api/usage?refresh=true');
        const res = createMockRes();
        // Provider with no uuid, no customName — PROVIDER_MAPPINGS is [] so credPathKey is null
        await handleGetUsage(req, res, {}, {
            providerPools: { 'gemini-cli-oauth': [{}] },
        });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        const instance = body.providers['gemini-cli-oauth'].instances[0];
        expect(instance.name).toBe('Unnamed');
    });
});

describe('usage-api.js - handleGetProviderUsage', () => {
    test('returns 200 for known provider with no pool data', async () => {
        const req = createMockReq('http://localhost/api/usage/gemini-cli-oauth');
        const res = createMockRes();
        await handleGetProviderUsage(req, res, {}, null, 'gemini-cli-oauth');
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body).toHaveProperty('serverTime');
        expect(body.providerType).toBe('gemini-cli-oauth');
    });

    test('returns cached provider data when available', async () => {
        const { readProviderUsageCache } = await import('../../../src/ui-modules/usage-cache.js');
        readProviderUsageCache.mockResolvedValueOnce({
            providerType: 'gemini-cli-oauth',
            instances: [],
        });

        const req = createMockReq('http://localhost/api/usage/gemini-cli-oauth');
        const res = createMockRes();
        await handleGetProviderUsage(req, res, {}, null, 'gemini-cli-oauth');
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.fromCache).toBe(true);
    });

    test('returns 500 when updateProviderUsageCache fails', async () => {
        const { readProviderUsageCache, updateProviderUsageCache } = await import(
            '../../../src/ui-modules/usage-cache.js',
        );
        readProviderUsageCache.mockResolvedValueOnce(null);
        updateProviderUsageCache.mockRejectedValueOnce(new Error('cache write failed'));
        const req = createMockReq('http://localhost/api/usage/gemini-cli-oauth');
        const res = createMockRes();
        await handleGetProviderUsage(req, res, {}, null, 'gemini-cli-oauth');
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('cache write failed');
    });
});
