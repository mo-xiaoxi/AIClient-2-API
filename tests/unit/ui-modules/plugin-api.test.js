/**
 * UI Module: plugin-api.js Tests
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

const mockPluginManager = {
    getPluginList: jest.fn(() => [
        { name: 'default-auth', enabled: true, description: 'Auth plugin' },
        { name: 'ai-monitor', enabled: false, description: 'Monitor plugin' },
    ]),
    setPluginEnabled: jest.fn().mockResolvedValue(undefined),
};

jest.unstable_mockModule('../../../src/core/plugin-manager.js', () => ({
    getPluginManager: jest.fn(() => mockPluginManager),
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

let handleGetPlugins;
let handleTogglePlugin;
let getRequestBody;

beforeAll(async () => {
    ({ handleGetPlugins, handleTogglePlugin } = await import('../../../src/ui-modules/plugin-api.js'));
    ({ getRequestBody } = await import('../../../src/utils/common.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    mockPluginManager.getPluginList.mockReturnValue([
        { name: 'default-auth', enabled: true, description: 'Auth plugin' },
        { name: 'ai-monitor', enabled: false, description: 'Monitor plugin' },
    ]);
    mockPluginManager.setPluginEnabled.mockResolvedValue(undefined);
});

describe('plugin-api.js - handleGetPlugins', () => {
    test('returns 200 with plugin list', async () => {
        const req = {};
        const res = createMockRes();
        await handleGetPlugins(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.plugins).toBeDefined();
        expect(Array.isArray(body.plugins)).toBe(true);
        expect(body.plugins).toHaveLength(2);
    });

    test('returns 500 when pluginManager throws', async () => {
        mockPluginManager.getPluginList.mockImplementation(() => {
            throw new Error('Plugin manager error');
        });
        const req = {};
        const res = createMockRes();
        await handleGetPlugins(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('Plugin manager error');
    });
});

describe('plugin-api.js - handleTogglePlugin', () => {
    test('enables a plugin successfully', async () => {
        getRequestBody.mockResolvedValue({ enabled: true });
        const req = {};
        const res = createMockRes();
        await handleTogglePlugin(req, res, 'ai-monitor');
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.plugin.name).toBe('ai-monitor');
        expect(body.plugin.enabled).toBe(true);
    });

    test('disables a plugin successfully', async () => {
        getRequestBody.mockResolvedValue({ enabled: false });
        const req = {};
        const res = createMockRes();
        await handleTogglePlugin(req, res, 'default-auth');
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.plugin.enabled).toBe(false);
    });

    test('returns 400 when enabled is not a boolean', async () => {
        getRequestBody.mockResolvedValue({ enabled: 'yes' });
        const req = {};
        const res = createMockRes();
        await handleTogglePlugin(req, res, 'some-plugin');
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('boolean');
    });

    test('returns 500 when setPluginEnabled throws', async () => {
        getRequestBody.mockResolvedValue({ enabled: true });
        mockPluginManager.setPluginEnabled.mockRejectedValue(new Error('Set failed'));
        const req = {};
        const res = createMockRes();
        await handleTogglePlugin(req, res, 'broken-plugin');
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('Set failed');
    });
});
