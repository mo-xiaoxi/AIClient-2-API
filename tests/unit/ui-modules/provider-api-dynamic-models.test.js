/**
 * provider-api.js — fetchDynamicModels / DYNAMIC_MODEL_PROVIDERS 路径（独立 mock，避免与 provider-api.test 冲突）
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

const listModelsMock = jest.fn().mockResolvedValue({
    data: [{ id: 'dynamic-a' }, { id: 'dynamic-b' }],
});

const getServiceAdapterMock = jest.fn(() => ({
    listModels: listModelsMock,
}));

jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
    getServiceAdapter: getServiceAdapterMock,
    getRegisteredProviders: jest.fn(() => ['forward-api']),
}));

jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getAllProviderModels: jest.fn(() => ({
        'forward-api': ['static-fallback'],
    })),
    getProviderModels: jest.fn((providerType) =>
        providerType === 'forward-api' ? ['static-fallback'] : [],
    ),
    DYNAMIC_MODEL_PROVIDERS: ['forward-api'],
}));

jest.unstable_mockModule('../../../src/utils/provider-utils.js', () => ({
    generateUUID: jest.fn(() => 'uuid'),
    createProviderConfig: jest.fn(),
    formatSystemPath: jest.fn((p) => p),
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

let handleGetProviderModels;
let handleGetProviderTypeModels;

beforeAll(async () => {
    const mod = await import('../../../src/ui-modules/provider-api.js');
    handleGetProviderModels = mod.handleGetProviderModels;
    handleGetProviderTypeModels = mod.handleGetProviderTypeModels;
});

beforeEach(() => {
    jest.clearAllMocks();
    getServiceAdapterMock.mockImplementation(() => ({
        listModels: listModelsMock,
    }));
    listModelsMock.mockResolvedValue({
        data: [{ id: 'dynamic-a' }, { id: 'dynamic-b' }],
    });
});

function createRes() {
    return { writeHead: jest.fn(), end: jest.fn() };
}

function poolManager() {
    return {
        globalConfig: {},
        providerStatus: {
            'forward-api': [{ config: { uuid: 'u1', isHealthy: true, isDisabled: false } }],
        },
    };
}

describe('provider-api dynamic models', () => {
    test('handleGetProviderModels merges adapter listModels ids for DYNAMIC_MODEL_PROVIDERS', async () => {
        const res = createRes();
        await handleGetProviderModels({}, res, poolManager());
        expect(listModelsMock).toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['forward-api']).toEqual(['dynamic-a', 'dynamic-b']);
    });

    test('handleGetProviderTypeModels uses dynamic list when type is dynamic', async () => {
        const res = createRes();
        await handleGetProviderTypeModels({}, res, 'forward-api', poolManager());
        expect(listModelsMock).toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.providerType).toBe('forward-api');
        expect(body.models).toEqual(['dynamic-a', 'dynamic-b']);
    });

    test('handleGetProviderModels keeps static list when listModels returns empty data', async () => {
        listModelsMock.mockResolvedValueOnce({ data: [] });
        const res = createRes();
        await handleGetProviderModels({}, res, poolManager());
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['forward-api']).toEqual(['static-fallback']);
    });

    test('keeps static when listModels rejects (fetchDynamicModels catch)', async () => {
        listModelsMock.mockRejectedValueOnce(new Error('upstream unavailable'));
        const res = createRes();
        await handleGetProviderModels({}, res, poolManager());
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['forward-api']).toEqual(['static-fallback']);
    });

    test('keeps static when getServiceAdapter throws', async () => {
        getServiceAdapterMock.mockImplementationOnce(() => {
            throw new Error('no adapter');
        });
        const res = createRes();
        await handleGetProviderModels({}, res, poolManager());
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['forward-api']).toEqual(['static-fallback']);
    });

    test('keeps static when adapter has no listModels method', async () => {
        getServiceAdapterMock.mockReturnValueOnce({});
        const res = createRes();
        await handleGetProviderModels({}, res, poolManager());
        expect(listModelsMock).not.toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['forward-api']).toEqual(['static-fallback']);
    });

    test('keeps static when listModels returns non-array data', async () => {
        listModelsMock.mockResolvedValueOnce({ data: { raw: true } });
        const res = createRes();
        await handleGetProviderModels({}, res, poolManager());
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['forward-api']).toEqual(['static-fallback']);
    });

    test('handleGetProviderTypeModels falls back to static when dynamic fetch fails', async () => {
        listModelsMock.mockRejectedValueOnce(new Error('network'));
        const res = createRes();
        await handleGetProviderTypeModels({}, res, 'forward-api', poolManager());
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.models).toEqual(['static-fallback']);
    });

    test('handleGetProviderModels does not call getServiceAdapter when providerPoolManager is null', async () => {
        const res = createRes();
        await handleGetProviderModels({}, res, null);
        expect(getServiceAdapterMock).not.toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body['forward-api']).toEqual(['static-fallback']);
    });

    test('handleGetProviderTypeModels uses static getProviderModels when providerPoolManager is null', async () => {
        const res = createRes();
        await handleGetProviderTypeModels({}, res, 'forward-api', null);
        expect(getServiceAdapterMock).not.toHaveBeenCalled();
        expect(listModelsMock).not.toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.models).toEqual(['static-fallback']);
    });
});
