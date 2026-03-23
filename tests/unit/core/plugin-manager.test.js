/**
 * Unit tests for plugin-manager.js
 *
 * Tests: PluginManager class — register, initAll, executeAuth,
 *        executeMiddleware, executeRoutes, getEnabledPlugins,
 *        getAuthPlugins, getMiddlewarePlugins, isPluginStaticPath,
 *        discoverPlugins (file-scan), getPluginManager singleton.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Module references
// ---------------------------------------------------------------------------
let PluginManager;
let PLUGIN_TYPE;
let getPluginManager;
let discoverPlugins;

// ---------------------------------------------------------------------------
// Mock fs state (controllable per test)
// ---------------------------------------------------------------------------
const mockExistsSync = jest.fn(() => false);
const mockReaddir = jest.fn(async () => []);
const mockReadFile = jest.fn(async () => '{}');
const mockWriteFile = jest.fn(async () => undefined);
const mockMkdir = jest.fn(async () => undefined);

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

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        existsSync: mockExistsSync,
        promises: {
            readdir: mockReaddir,
            readFile: mockReadFile,
            writeFile: mockWriteFile,
            mkdir: mockMkdir,
        },
    }));

    // path is used internally, let real path module work
    const mod = await import('../../../src/core/plugin-manager.js');
    PluginManager = mod.PluginManager;
    PLUGIN_TYPE = mod.PLUGIN_TYPE;
    getPluginManager = mod.getPluginManager;
    discoverPlugins = mod.discoverPlugins;
});

beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
    mockReaddir.mockResolvedValue([]);
    mockReadFile.mockResolvedValue('{}');
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeAuthPlugin(name, authorizedResult = true) {
    return {
        name,
        version: '1.0.0',
        type: PLUGIN_TYPE.AUTH,
        _enabled: true,
        authenticate: jest.fn(async () => ({ authorized: authorizedResult, handled: false })),
    };
}

function makeMiddlewarePlugin(name, handled = false) {
    return {
        name,
        version: '1.0.0',
        _enabled: true,
        middleware: jest.fn(async () => ({ handled })),
    };
}

// ---------------------------------------------------------------------------
// Tests: register
// ---------------------------------------------------------------------------
describe('PluginManager — register', () => {
    test('registers a plugin successfully', () => {
        const pm = new PluginManager();
        const plugin = { name: 'test-plugin', version: '1.0.0' };
        pm.register(plugin);
        expect(pm.plugins.has('test-plugin')).toBe(true);
    });

    test('throws if plugin has no name', () => {
        const pm = new PluginManager();
        expect(() => pm.register({})).toThrow('Plugin must have a name');
    });

    test('does not register duplicate plugin names', () => {
        const pm = new PluginManager();
        pm.register({ name: 'dup', version: '1.0.0' });
        pm.register({ name: 'dup', version: '2.0.0' });
        expect(pm.plugins.size).toBe(1);
    });

    test('registered plugin is accessible via plugins Map', () => {
        const pm = new PluginManager();
        const plugin = { name: 'my-plugin', version: '0.1.0', description: 'test' };
        pm.register(plugin);
        expect(pm.plugins.get('my-plugin')).toBe(plugin);
    });
});

// ---------------------------------------------------------------------------
// Tests: initAll
// ---------------------------------------------------------------------------
describe('PluginManager — initAll', () => {
    test('calls init on enabled plugin', async () => {
        const pm = new PluginManager();
        const initFn = jest.fn().mockResolvedValue(undefined);
        pm.register({ name: 'p1', version: '1.0.0', init: initFn });
        // Bypass loadConfig and set pluginsConfig directly
        pm.loadConfig = jest.fn(async () => {
            pm.pluginsConfig = { plugins: { p1: { enabled: true } } };
        });
        await pm.initAll({});
        expect(initFn).toHaveBeenCalledTimes(1);
        expect(pm.plugins.get('p1')._enabled).toBe(true);
    });

    test('does not call init on disabled plugin', async () => {
        const pm = new PluginManager();
        const initFn = jest.fn();
        pm.register({ name: 'p2', version: '1.0.0', init: initFn });
        // Bypass loadConfig and set pluginsConfig directly to mark p2 as disabled
        pm.loadConfig = jest.fn(async () => {
            pm.pluginsConfig = { plugins: { p2: { enabled: false } } };
        });
        await pm.initAll({});
        expect(initFn).not.toHaveBeenCalled();
    });

    test('sets initialized to true after initAll', async () => {
        const pm = new PluginManager();
        pm.loadConfig = jest.fn(async () => undefined);
        await pm.initAll({});
        expect(pm.initialized).toBe(true);
    });

    test('plugin init failure sets _enabled to false', async () => {
        const pm = new PluginManager();
        pm.register({
            name: 'bad-plugin',
            version: '1.0.0',
            init: jest.fn().mockRejectedValue(new Error('Init failed')),
        });
        pm.loadConfig = jest.fn(async () => {
            pm.pluginsConfig = { plugins: { 'bad-plugin': { enabled: true } } };
        });
        await pm.initAll({});
        expect(pm.plugins.get('bad-plugin')._enabled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Tests: getEnabledPlugins / getAuthPlugins / getMiddlewarePlugins
// ---------------------------------------------------------------------------
describe('PluginManager — plugin listing', () => {
    test('getEnabledPlugins returns only _enabled plugins', () => {
        const pm = new PluginManager();
        pm.register({ name: 'a', version: '1.0.0', _enabled: true });
        pm.register({ name: 'b', version: '1.0.0', _enabled: false });
        pm.register({ name: 'c', version: '1.0.0', _enabled: true });
        const enabled = pm.getEnabledPlugins();
        expect(enabled.map(p => p.name)).toEqual(expect.arrayContaining(['a', 'c']));
        expect(enabled.find(p => p.name === 'b')).toBeUndefined();
    });

    test('getAuthPlugins returns only auth-type enabled plugins with authenticate method', () => {
        const pm = new PluginManager();
        pm.register({ name: 'auth1', version: '1.0.0', _enabled: true, type: PLUGIN_TYPE.AUTH, authenticate: jest.fn() });
        pm.register({ name: 'mid1', version: '1.0.0', _enabled: true, middleware: jest.fn() });
        const authPlugins = pm.getAuthPlugins();
        expect(authPlugins).toHaveLength(1);
        expect(authPlugins[0].name).toBe('auth1');
    });

    test('getMiddlewarePlugins returns only non-auth enabled plugins with middleware method', () => {
        const pm = new PluginManager();
        pm.register({ name: 'mid1', version: '1.0.0', _enabled: true, middleware: jest.fn() });
        pm.register({ name: 'auth1', version: '1.0.0', _enabled: true, type: PLUGIN_TYPE.AUTH, authenticate: jest.fn() });
        const midPlugins = pm.getMiddlewarePlugins();
        expect(midPlugins).toHaveLength(1);
        expect(midPlugins[0].name).toBe('mid1');
    });

    test('getEnabledPlugins sorts non-builtin before builtin', () => {
        const pm = new PluginManager();
        pm.register({ name: 'builtin', version: '1.0.0', _enabled: true, _builtin: true });
        pm.register({ name: 'normal', version: '1.0.0', _enabled: true });
        const sorted = pm.getEnabledPlugins();
        expect(sorted[0].name).toBe('normal');
        expect(sorted[1].name).toBe('builtin');
    });

    test('getEnabledPlugins sorts by priority (lower number first)', () => {
        const pm = new PluginManager();
        pm.register({ name: 'high', version: '1.0.0', _enabled: true, _priority: 200 });
        pm.register({ name: 'low', version: '1.0.0', _enabled: true, _priority: 50 });
        const sorted = pm.getEnabledPlugins();
        expect(sorted[0].name).toBe('low');
    });
});

// ---------------------------------------------------------------------------
// Tests: executeAuth
// ---------------------------------------------------------------------------
describe('PluginManager — executeAuth', () => {
    test('returns authorized:true when an auth plugin succeeds', async () => {
        const pm = new PluginManager();
        pm.register(makeAuthPlugin('auth-ok', true));
        const result = await pm.executeAuth({}, {}, new URL('http://localhost/'), {});
        expect(result.authorized).toBe(true);
        expect(result.handled).toBe(false);
    });

    test('returns authorized:false with handled:true when auth plugin returns authorized:false', async () => {
        const pm = new PluginManager();
        const plugin = makeAuthPlugin('auth-deny');
        plugin.authenticate = jest.fn(async () => ({ authorized: false, handled: false }));
        pm.register(plugin);
        const result = await pm.executeAuth({}, {}, new URL('http://localhost/'), {});
        expect(result.authorized).toBe(false);
        expect(result.handled).toBe(true);
    });

    test('returns authorized:false when no auth plugins registered', async () => {
        const pm = new PluginManager();
        const result = await pm.executeAuth({}, {}, new URL('http://localhost/'), {});
        expect(result.authorized).toBe(false);
        expect(result.handled).toBe(false);
    });

    test('stops at first authorizing plugin and merges data into config', async () => {
        const pm = new PluginManager();
        const plugin = makeAuthPlugin('auth-data');
        plugin.authenticate = jest.fn(async () => ({
            authorized: true,
            handled: false,
            data: { userId: '42' },
        }));
        pm.register(plugin);
        const config = {};
        await pm.executeAuth({}, {}, new URL('http://localhost/'), config);
        expect(config.userId).toBe('42');
    });

    test('skips plugin error and continues to next plugin', async () => {
        const pm = new PluginManager();
        const badPlugin = { name: 'bad-auth', version: '1.0.0', _enabled: true, type: PLUGIN_TYPE.AUTH,
            authenticate: jest.fn().mockRejectedValue(new Error('crash')) };
        const goodPlugin = makeAuthPlugin('good-auth', true);
        pm.register(badPlugin);
        pm.register(goodPlugin);
        const result = await pm.executeAuth({}, {}, new URL('http://localhost/'), {});
        expect(result.authorized).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: executeMiddleware
// ---------------------------------------------------------------------------
describe('PluginManager — executeMiddleware', () => {
    test('returns handled:false when no middleware plugins', async () => {
        const pm = new PluginManager();
        const result = await pm.executeMiddleware({}, {}, new URL('http://localhost/'), {});
        expect(result.handled).toBe(false);
    });

    test('returns handled:true when a middleware plugin handles the request', async () => {
        const pm = new PluginManager();
        pm.register(makeMiddlewarePlugin('mid-handle', true));
        const result = await pm.executeMiddleware({}, {}, new URL('http://localhost/'), {});
        expect(result.handled).toBe(true);
    });

    test('continues if middleware returns null', async () => {
        const pm = new PluginManager();
        pm.register({
            name: 'mid-null', version: '1.0.0', _enabled: true,
            middleware: jest.fn(async () => null),
        });
        const result = await pm.executeMiddleware({}, {}, new URL('http://localhost/'), {});
        expect(result.handled).toBe(false);
    });

    test('merges data from middleware into config', async () => {
        const pm = new PluginManager();
        pm.register({
            name: 'mid-data', version: '1.0.0', _enabled: true,
            middleware: jest.fn(async () => ({ handled: false, data: { extra: 'info' } })),
        });
        const config = {};
        await pm.executeMiddleware({}, {}, new URL('http://localhost/'), config);
        expect(config.extra).toBe('info');
    });
});

// ---------------------------------------------------------------------------
// Tests: executeRoutes
// ---------------------------------------------------------------------------
describe('PluginManager — executeRoutes', () => {
    test('returns false when no plugins have routes', async () => {
        const pm = new PluginManager();
        pm.register({ name: 'no-routes', version: '1.0.0', _enabled: true });
        const handled = await pm.executeRoutes('GET', '/some/path', {}, {});
        expect(handled).toBe(false);
    });

    test('matches exact string route and returns true when handler returns true', async () => {
        const pm = new PluginManager();
        const handler = jest.fn(async () => true);
        pm.register({
            name: 'route-plugin', version: '1.0.0', _enabled: true,
            routes: [{ method: 'GET', path: '/special', handler }],
        });
        const handled = await pm.executeRoutes('GET', '/special', {}, {});
        expect(handled).toBe(true);
        expect(handler).toHaveBeenCalled();
    });

    test('does not match route with wrong HTTP method', async () => {
        const pm = new PluginManager();
        const handler = jest.fn(async () => true);
        pm.register({
            name: 'route-plugin', version: '1.0.0', _enabled: true,
            routes: [{ method: 'POST', path: '/special', handler }],
        });
        const handled = await pm.executeRoutes('GET', '/special', {}, {});
        expect(handled).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });

    test('wildcard method * matches any HTTP method', async () => {
        const pm = new PluginManager();
        const handler = jest.fn(async () => true);
        pm.register({
            name: 'wildcard', version: '1.0.0', _enabled: true,
            routes: [{ method: '*', path: '/any', handler }],
        });
        const handled = await pm.executeRoutes('DELETE', '/any', {}, {});
        expect(handled).toBe(true);
    });

    test('regex route matches path', async () => {
        const pm = new PluginManager();
        const handler = jest.fn(async () => true);
        pm.register({
            name: 'regex-plugin', version: '1.0.0', _enabled: true,
            routes: [{ method: 'GET', path: /^\/api\/.*/, handler }],
        });
        const handled = await pm.executeRoutes('GET', '/api/anything', {}, {});
        expect(handled).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: isPluginStaticPath
// ---------------------------------------------------------------------------
describe('PluginManager — isPluginStaticPath', () => {
    test('returns false when no plugins have static paths', () => {
        const pm = new PluginManager();
        pm.register({ name: 'no-static', version: '1.0.0', _enabled: true });
        expect(pm.isPluginStaticPath('/some/path')).toBe(false);
    });

    test('returns true for a registered static path', () => {
        const pm = new PluginManager();
        pm.register({
            name: 'static-plugin', version: '1.0.0', _enabled: true,
            staticPaths: ['plugin-ui.html'],
        });
        expect(pm.isPluginStaticPath('/plugin-ui.html')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: getPluginManager singleton
// ---------------------------------------------------------------------------
describe('getPluginManager', () => {
    test('returns the same instance on multiple calls', () => {
        const a = getPluginManager();
        const b = getPluginManager();
        expect(a).toBe(b);
    });

    test('returned instance is a PluginManager', () => {
        const pm = getPluginManager();
        expect(pm).toBeInstanceOf(PluginManager);
    });
});

// ---------------------------------------------------------------------------
// Tests: discoverPlugins
// ---------------------------------------------------------------------------
describe('discoverPlugins', () => {
    test('does not throw when plugins directory does not exist', async () => {
        mockExistsSync.mockReturnValue(false);
        mockMkdir.mockResolvedValue(undefined);
        await expect(discoverPlugins()).resolves.not.toThrow();
    });

    test('does not throw when readdir returns empty list', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([]);
        await expect(discoverPlugins()).resolves.not.toThrow();
    });
});
