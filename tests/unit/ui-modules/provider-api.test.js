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
let getRequestBody;

beforeAll(async () => {
    ({
        handleGetProviders,
        handleGetSupportedProviders,
        handleGetProviderType,
        handleGetProviderModels,
        handleGetProviderTypeModels,
        handleAddProvider,
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
            providerConfig: { apiKey: 'sk-test' },
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
