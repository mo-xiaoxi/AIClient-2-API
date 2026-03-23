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
});
