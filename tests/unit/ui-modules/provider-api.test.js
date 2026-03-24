/**
 * UI Module: provider-api.js Tests
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

jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: jest.fn(() => false),
        readFileSync: jest.fn(() => '{}'),
        writeFileSync: jest.fn(),
    };
});

jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getAllProviderModels: jest.fn(() => ({
        'gemini-cli-oauth': ['gemini-pro', 'gemini-pro-vision'],
        'openai-custom': ['gpt-4', 'gpt-3.5-turbo'],
    })),
    getProviderModels: jest.fn((providerType) => {
        const map = {
            'gemini-cli-oauth': ['gemini-pro'],
            'openai-custom': ['gpt-4'],
        };
        return map[providerType] || [];
    }),
    DYNAMIC_MODEL_PROVIDERS: [],
}));

jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(() => null),
    getRegisteredProviders: jest.fn(() => ['gemini-cli-oauth', 'openai-custom', 'claude-custom']),
}));

jest.unstable_mockModule('../../../src/utils/provider-utils.js', () => ({
    generateUUID: jest.fn(() => 'test-uuid-1234'),
    createProviderConfig: jest.fn(),
    formatSystemPath: jest.fn(p => p),
    detectProviderFromPath: jest.fn(),
    addToUsedPaths: jest.fn(),
    isPathUsed: jest.fn(() => false),
    pathsEqual: jest.fn(() => false),
}));

jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    getRequestBody: jest.fn(),
    MODEL_PROTOCOL_PREFIX: {},
}));

jest.unstable_mockModule('../../../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn(),
}));

function createMockRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
    };
}

let handleGetProviders;
let handleGetSupportedProviders;
let handleGetProviderType;
let handleGetProviderModels;
let handleGetProviderTypeModels;
let handleAddProvider;
let handleUpdateProvider;
let handleDeleteProvider;
let handleDisableEnableProvider;
let handleResetProviderHealth;
let handleDeleteUnhealthyProviders;
let handleRefreshUnhealthyUuids;
let handleHealthCheck;
let handleQuickLinkProvider;
let handleRefreshProviderUuid;
let getRequestBody;

beforeAll(async () => {
    ({
        handleGetProviders,
        handleGetSupportedProviders,
        handleGetProviderType,
        handleGetProviderModels,
        handleGetProviderTypeModels,
        handleAddProvider,
        handleUpdateProvider,
        handleDeleteProvider,
        handleDisableEnableProvider,
        handleResetProviderHealth,
        handleDeleteUnhealthyProviders,
        handleRefreshUnhealthyUuids,
        handleHealthCheck,
        handleQuickLinkProvider,
        handleRefreshProviderUuid,
    } = await import('../../../src/ui-modules/provider-api.js'));
    ({ getRequestBody } = await import('../../../src/utils/common.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('provider-api.js - handleGetProviders', () => {
    test('returns 200 with empty provider pools when no file exists', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = { PROVIDER_POOLS_FILE_PATH: null };
        await handleGetProviders(req, res, currentConfig, null);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(typeof body).toBe('object');
    });

    test('returns provider pools from providerPoolManager when available', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = {};
        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': [{ uuid: 'abc', isHealthy: true }],
            },
        };
        await handleGetProviders(req, res, currentConfig, providerPoolManager);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['gemini-cli-oauth']).toBeDefined();
        expect(body['gemini-cli-oauth'][0].uuid).toBe('abc');
    });
});

describe('provider-api.js - handleGetSupportedProviders', () => {
    test('returns 200 with registered provider list', async () => {
        const req = {};
        const res = createMockRes();
        await handleGetSupportedProviders(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(Array.isArray(body)).toBe(true);
        expect(body).toContain('gemini-cli-oauth');
    });
});

describe('provider-api.js - handleGetProviderType', () => {
    test('returns 200 with provider type info', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = {};
        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': [
                    { uuid: 'p1', isHealthy: true },
                    { uuid: 'p2', isHealthy: false },
                ],
            },
        };
        await handleGetProviderType(req, res, currentConfig, providerPoolManager, 'gemini-cli-oauth');
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.providerType).toBe('gemini-cli-oauth');
        expect(body.totalCount).toBe(2);
        expect(body.healthyCount).toBe(1);
    });

    test('returns empty providers when type not found', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = {};
        const providerPoolManager = { providerPools: {} };
        await handleGetProviderType(req, res, currentConfig, providerPoolManager, 'unknown-type');
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.totalCount).toBe(0);
    });
});

describe('provider-api.js - handleGetProviderModels', () => {
    test('returns 200 with all provider models', async () => {
        const req = {};
        const res = createMockRes();
        await handleGetProviderModels(req, res, null);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['gemini-cli-oauth']).toBeDefined();
        expect(body['openai-custom']).toBeDefined();
    });
});

describe('provider-api.js - handleGetProviderTypeModels', () => {
    test('returns 200 with models for specific provider type', async () => {
        const req = {};
        const res = createMockRes();
        await handleGetProviderTypeModels(req, res, 'gemini-cli-oauth', null);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.providerType).toBe('gemini-cli-oauth');
        expect(Array.isArray(body.models)).toBe(true);
    });

    test('returns empty models for unknown provider type', async () => {
        const req = {};
        const res = createMockRes();
        await handleGetProviderTypeModels(req, res, 'unknown-provider', null);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.models).toEqual([]);
    });
});

describe('provider-api.js - handleAddProvider', () => {
    test('returns 400 when providerType is missing', async () => {
        getRequestBody.mockResolvedValue({ providerConfig: {} });
        const req = {};
        const res = createMockRes();
        await handleAddProvider(req, res, {}, null);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('required');
    });

    test('returns 400 when providerConfig is missing', async () => {
        getRequestBody.mockResolvedValue({ providerType: 'gemini-cli-oauth' });
        const req = {};
        const res = createMockRes();
        await handleAddProvider(req, res, {}, null);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('adds provider successfully and returns 200', async () => {
        const { writeFileSync } = await import('fs');
        writeFileSync.mockImplementation(() => {});
        getRequestBody.mockResolvedValue({
            providerType: 'gemini-cli-oauth',
            providerConfig: { credentials: '/path/to/creds.json' },
        });

        const req = {};
        const res = createMockRes();
        const currentConfig = { PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json' };
        await handleAddProvider(req, res, currentConfig, null);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.providerType).toBe('gemini-cli-oauth');
        expect(body.provider.uuid).toBe('test-uuid-1234');
    });

    test('updates providerPoolManager when provided', async () => {
        const { writeFileSync } = await import('fs');
        writeFileSync.mockImplementation(() => {});
        getRequestBody.mockResolvedValue({
            providerType: 'openai-custom',
            providerConfig: { apiKey: 'test-api-key-placeholder' },
        });

        const req = {};
        const res = createMockRes();
        const currentConfig = {};
        const providerPoolManager = {
            providerPools: {},
            initializeProviderStatus: jest.fn(),
        };
        await handleAddProvider(req, res, currentConfig, providerPoolManager);
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalled();
        expect(providerPoolManager.providerPools['openai-custom']).toBeDefined();
    });
});

describe('provider-api.js - handleUpdateProvider', () => {
    test('returns 404 when provider uuid not found', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({ 'gemini-cli-oauth': [{ uuid: 'other', isHealthy: true }] }),
        );
        getRequestBody.mockResolvedValue({ providerConfig: { label: 'x' } });
        const res = createMockRes();
        await handleUpdateProvider(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            null,
            'gemini-cli-oauth',
            'missing-uuid',
        );
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('merges providerConfig and returns 200', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({
                'gemini-cli-oauth': [{ uuid: 'u1', isHealthy: true, usageCount: 2, errorCount: 0 }],
            }),
        );
        fs.writeFileSync.mockImplementation(() => {});
        getRequestBody.mockResolvedValue({ providerConfig: { label: 'updated' } });
        const res = createMockRes();
        const pm = { initializeProviderStatus: jest.fn() };
        await handleUpdateProvider(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            pm,
            'gemini-cli-oauth',
            'u1',
        );
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.provider.uuid).toBe('u1');
        expect(body.provider.label).toBe('updated');
        expect(pm.initializeProviderStatus).toHaveBeenCalled();
    });
});

describe('provider-api.js - handleDeleteProvider', () => {
    test('returns 404 when provider uuid not in pools', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({ 'gemini-cli-oauth': [] }));
        const res = createMockRes();
        await handleDeleteProvider(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            null,
            'gemini-cli-oauth',
            'nope',
        );
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('removes provider and returns 200', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({ 'gemini-cli-oauth': [{ uuid: 'u1' }] }));
        fs.writeFileSync.mockImplementation(() => {});
        const res = createMockRes();
        await handleDeleteProvider(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            null,
            'gemini-cli-oauth',
            'u1',
        );
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.deletedProvider.uuid).toBe('u1');
    });
});

describe('provider-api.js - handleDisableEnableProvider', () => {
    test('disable sets isDisabled and calls pool manager', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({ 'gemini-cli-oauth': [{ uuid: 'u1', isDisabled: false }] }),
        );
        fs.writeFileSync.mockImplementation(() => {});
        const res = createMockRes();
        const pm = {
            disableProvider: jest.fn(),
            enableProvider: jest.fn(),
        };
        await handleDisableEnableProvider(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            pm,
            'gemini-cli-oauth',
            'u1',
            'disable',
        );
        expect(pm.disableProvider).toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.provider.isDisabled).toBe(true);
    });
});

describe('provider-api.js - handleResetProviderHealth', () => {
    test('returns 404 when no providers for type', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({ 'gemini-cli-oauth': [] }));
        const res = createMockRes();
        await handleResetProviderHealth(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            null,
            'gemini-cli-oauth',
        );
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('resets health flags and returns 200', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({
                'gemini-cli-oauth': [
                    { uuid: 'u1', isHealthy: false, errorCount: 3, needsRefresh: true },
                ],
            }),
        );
        fs.writeFileSync.mockImplementation(() => {});
        const res = createMockRes();
        const pm = { initializeProviderStatus: jest.fn() };
        await handleResetProviderHealth(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.resetCount).toBe(1);
        expect(pm.initializeProviderStatus).toHaveBeenCalled();
    });
});

describe('provider-api.js - handleDeleteUnhealthyProviders', () => {
    test('returns 200 when no unhealthy nodes', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({
                'gemini-cli-oauth': [{ uuid: 'u1', isHealthy: true }],
            }),
        );
        const res = createMockRes();
        await handleDeleteUnhealthyProviders(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            null,
            'gemini-cli-oauth',
        );
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.deletedCount).toBe(0);
    });

    test('removes unhealthy providers and returns counts', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({
                'gemini-cli-oauth': [
                    { uuid: 'bad', isHealthy: false },
                    { uuid: 'good', isHealthy: true },
                ],
            }),
        );
        fs.writeFileSync.mockImplementation(() => {});
        const res = createMockRes();
        const pm = { initializeProviderStatus: jest.fn() };
        await handleDeleteUnhealthyProviders(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.deletedCount).toBe(1);
        expect(body.remainingCount).toBe(1);
        expect(pm.initializeProviderStatus).toHaveBeenCalled();
    });
});

describe('provider-api.js - handleRefreshUnhealthyUuids', () => {
    test('returns 200 when no unhealthy providers need refresh', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({
                'gemini-cli-oauth': [{ uuid: 'u1', isHealthy: true }],
            }),
        );
        const res = createMockRes();
        await handleRefreshUnhealthyUuids(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            null,
            'gemini-cli-oauth',
        );
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.refreshedCount).toBe(0);
    });

    test('assigns new uuid to unhealthy provider', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({
                'gemini-cli-oauth': [{ uuid: 'old-uuid', isHealthy: false, customName: 'n' }],
            }),
        );
        fs.writeFileSync.mockImplementation(() => {});
        const res = createMockRes();
        const pm = { initializeProviderStatus: jest.fn() };
        await handleRefreshUnhealthyUuids(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.refreshedCount).toBe(1);
        expect(body.refreshedProviders[0].oldUuid).toBe('old-uuid');
        expect(body.refreshedProviders[0].newUuid).toBe('test-uuid-1234');
    });
});

describe('provider-api.js - handleHealthCheck', () => {
    test('returns 400 when providerPoolManager missing', async () => {
        const res = createMockRes();
        await handleHealthCheck({}, res, {}, null, 'gemini-cli-oauth');
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 404 when providerStatus empty for type', async () => {
        const res = createMockRes();
        const pm = { providerStatus: {} };
        await handleHealthCheck({}, res, {}, pm, 'gemini-cli-oauth');
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 when all providers healthy', async () => {
        const res = createMockRes();
        const pm = {
            providerStatus: {
                'gemini-cli-oauth': [{ config: { uuid: 'u1', isHealthy: true } }],
            },
        };
        await handleHealthCheck({}, res, {}, pm, 'gemini-cli-oauth');
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.successCount).toBe(0);
        expect(body.message).toContain('No unhealthy');
    });

    test('marks provider healthy when _checkProviderHealth succeeds', async () => {
        const fs = await import('fs');
        fs.writeFileSync.mockImplementation(() => {});
        const markProviderHealthy = jest.fn();
        const res = createMockRes();
        const pm = {
            providerStatus: {
                'gemini-cli-oauth': [
                    { config: { uuid: 'u1', isHealthy: false, isDisabled: false } },
                ],
            },
            _checkProviderHealth: jest
                .fn()
                .mockResolvedValue({ success: true, modelName: 'gemini-pro' }),
            markProviderHealthy,
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
        };
        await handleHealthCheck(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(markProviderHealthy).toHaveBeenCalled();
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.results.some((r) => r.success === true && r.uuid === 'u1')).toBe(true);
    });

    test('pushes null result when health check not supported', async () => {
        const fs = await import('fs');
        fs.writeFileSync.mockImplementation(() => {});
        const res = createMockRes();
        const pm = {
            providerStatus: {
                'gemini-cli-oauth': [
                    { config: { uuid: 'u1', isHealthy: false, isDisabled: false } },
                ],
            },
            _checkProviderHealth: jest.fn().mockResolvedValue(null),
        };
        await handleHealthCheck(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            pm,
            'gemini-cli-oauth',
        );
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.results[0].success).toBeNull();
    });

    test('calls markProviderUnhealthyImmediately on auth-style failure', async () => {
        const fs = await import('fs');
        fs.writeFileSync.mockImplementation(() => {});
        const markImmediate = jest.fn();
        const res = createMockRes();
        const pm = {
            providerStatus: {
                'gemini-cli-oauth': [
                    { config: { uuid: 'u1', isHealthy: false, isDisabled: false } },
                ],
            },
            _checkProviderHealth: jest.fn().mockResolvedValue({
                success: false,
                errorMessage: '401 Unauthorized',
            }),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: markImmediate,
        };
        await handleHealthCheck(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(markImmediate).toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.results[0].isAuthError).toBe(true);
    });

    test('calls markProviderUnhealthy on non-auth failure from _checkProviderHealth', async () => {
        const fs = await import('fs');
        fs.writeFileSync.mockImplementation(() => {});
        const markUnhealthy = jest.fn();
        const markImmediate = jest.fn();
        const res = createMockRes();
        const pm = {
            providerStatus: {
                'gemini-cli-oauth': [
                    { config: { uuid: 'u1', isHealthy: false, isDisabled: false } },
                ],
            },
            _checkProviderHealth: jest.fn().mockResolvedValue({
                success: false,
                errorMessage: 'timeout or rate limit',
                modelName: 'm1',
            }),
            markProviderHealthy: jest.fn(),
            markProviderUnhealthy: markUnhealthy,
            markProviderUnhealthyImmediately: markImmediate,
        };
        await handleHealthCheck(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(markUnhealthy).toHaveBeenCalled();
        expect(markImmediate).not.toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.results[0].isAuthError).toBe(false);
    });

    test('catch: markProviderUnhealthy when _checkProviderHealth throws generic error', async () => {
        const fs = await import('fs');
        fs.writeFileSync.mockImplementation(() => {});
        const markUnhealthy = jest.fn();
        const markImmediate = jest.fn();
        const res = createMockRes();
        const pm = {
            providerStatus: {
                'gemini-cli-oauth': [
                    { config: { uuid: 'u1', isHealthy: false, isDisabled: false } },
                ],
            },
            _checkProviderHealth: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
            markProviderUnhealthy: markUnhealthy,
            markProviderUnhealthyImmediately: markImmediate,
        };
        await handleHealthCheck(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(markUnhealthy).toHaveBeenCalled();
        expect(markImmediate).not.toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.results[0].isAuthError).toBe(false);
    });

    test('catch: markProviderUnhealthyImmediately when throw message looks like auth', async () => {
        const fs = await import('fs');
        fs.writeFileSync.mockImplementation(() => {});
        const markImmediate = jest.fn();
        const res = createMockRes();
        const pm = {
            providerStatus: {
                'gemini-cli-oauth': [
                    { config: { uuid: 'u1', isHealthy: false, isDisabled: false } },
                ],
            },
            _checkProviderHealth: jest
                .fn()
                .mockRejectedValue(new Error('HTTP 403 Forbidden')),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: markImmediate,
        };
        await handleHealthCheck(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(markImmediate).toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.results[0].isAuthError).toBe(true);
    });

    test('skips disabled unhealthy providers without calling _checkProviderHealth', async () => {
        const fs = await import('fs');
        fs.writeFileSync.mockImplementation(() => {});
        const check = jest.fn();
        const res = createMockRes();
        const pm = {
            providerStatus: {
                'gemini-cli-oauth': [
                    { config: { uuid: 'u1', isHealthy: false, isDisabled: true } },
                ],
            },
            _checkProviderHealth: check,
        };
        await handleHealthCheck(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/pools.json' },
            pm,
            'gemini-cli-oauth',
        );
        expect(check).not.toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.results).toEqual([]);
    });
});

describe('provider-api.js - handleQuickLinkProvider', () => {
    test('returns 400 when no file paths in body', async () => {
        getRequestBody.mockResolvedValue({});
        const res = createMockRes();
        await handleQuickLinkProvider({}, res, {}, null);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('links file when detectProviderFromPath returns mapping', async () => {
        getRequestBody.mockResolvedValue({ filePath: '/home/user/.gemini/oauth.json' });
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(false);
        fs.writeFileSync.mockImplementation(() => {});
        const pu = await import('../../../src/utils/provider-utils.js');
        pu.detectProviderFromPath.mockReturnValue({
            providerType: 'gemini-cli-oauth',
            credPathKey: 'credentials',
            defaultCheckModel: 'gemini-pro',
            displayName: 'Gemini',
            needsProjectId: false,
        });
        pu.createProviderConfig.mockReturnValue({
            uuid: 'linked-uuid',
            credentials: '/home/user/.gemini/oauth.json',
        });
        const res = createMockRes();
        const pm = { initializeProviderStatus: jest.fn() };
        await handleQuickLinkProvider({}, res, { PROVIDER_POOLS_FILE_PATH: '/pools.json' }, pm);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.successCount).toBeGreaterThanOrEqual(1);
        expect(pm.initializeProviderStatus).toHaveBeenCalled();
    });
});

describe('provider-api.js - handleRefreshProviderUuid', () => {
    test('returns 404 when provider uuid not in file', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({ 'gemini-cli-oauth': [{ uuid: 'other' }] }),
        );
        const res = createMockRes();
        await handleRefreshProviderUuid(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            null,
            'gemini-cli-oauth',
            'missing-uuid',
        );
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('writes new uuid and returns 200', async () => {
        const fs = await import('fs');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({ 'gemini-cli-oauth': [{ uuid: 'old-id', name: 'acc' }] }),
        );
        fs.writeFileSync.mockImplementation(() => {});
        const res = createMockRes();
        const pm = { initializeProviderStatus: jest.fn() };
        await handleRefreshProviderUuid(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: '/p.json' },
            pm,
            'gemini-cli-oauth',
            'old-id',
        );
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.oldUuid).toBe('old-id');
        expect(body.newUuid).toBe('test-uuid-1234');
        expect(body.provider.uuid).toBe('test-uuid-1234');
        expect(pm.initializeProviderStatus).toHaveBeenCalled();
    });
});
