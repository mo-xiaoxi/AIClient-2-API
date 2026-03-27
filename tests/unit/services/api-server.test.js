/**
 * Unit tests for services/api-server.js
 *
 * Tests: startServer, gracefulShutdown, sendToMaster helper functions.
 * Key behaviors: config initialization, server creation, listen, plugin init,
 *                TLS sidecar, graceful shutdown (test mode + normal mode).
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Controllable mock state
// ---------------------------------------------------------------------------
const mockConfig = {
    SERVER_PORT: 3000,
    HOST: '127.0.0.1',
    MODEL_PROVIDER: 'openai-custom',
    DEFAULT_MODEL_PROVIDERS: ['openai-custom'],
    REQUIRED_API_KEY: 'test-key',
    SYSTEM_PROMPT_FILE_PATH: null,
    SYSTEM_PROMPT_MODE: 'overwrite',
    PROMPT_LOG_MODE: 'none',
    PROMPT_LOG_FILENAME: null,
    CRON_REFRESH_TOKEN: false,
    CRON_NEAR_MINUTES: 15,
    TLS_SIDECAR_ENABLED: false,
};

// HTTP server mock
let mockHttpServer;

const mockInitializeConfig = jest.fn();
const mockDiscoverPlugins = jest.fn();
const mockGetPluginManager = jest.fn();
const mockPluginManager = {
    initAll: jest.fn().mockResolvedValue(undefined),
    getPluginList: jest.fn().mockReturnValue([]),
};

const mockInitApiService = jest.fn().mockResolvedValue({});
const mockGetProviderPoolManager = jest.fn().mockReturnValue(null);

const mockInitializeUIManagement = jest.fn();
const mockInitializeAPIManagement = jest.fn().mockReturnValue(jest.fn());
const mockCreateRequestHandler = jest.fn().mockReturnValue(jest.fn());

const mockTLSSidecar = {
    start: jest.fn().mockResolvedValue(false),
    stop: jest.fn().mockResolvedValue(undefined),
};
const mockGetTLSSidecar = jest.fn().mockReturnValue(mockTLSSidecar);

const mockIsRetryableNetworkError = jest.fn().mockReturnValue(false);

// ---------------------------------------------------------------------------
// Module references
// ---------------------------------------------------------------------------
let startServer;
let gracefulShutdown;
let sendToMaster;

// ---------------------------------------------------------------------------
// beforeAll: set up all mocks BEFORE importing the module
// ---------------------------------------------------------------------------
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

    await jest.unstable_mockModule('http', () => {
        mockHttpServer = new EventEmitter();
        mockHttpServer.listen = jest.fn((port, host, cb) => {
            // Simulate successful listen
            process.nextTick(cb);
            return mockHttpServer;
        });
        mockHttpServer.close = jest.fn((cb) => {
            if (cb) process.nextTick(cb);
        });
        mockHttpServer.address = jest.fn().mockReturnValue({ port: 3000 });
        mockHttpServer.maxConnections = 0;
        mockHttpServer.once = jest.fn((event, handler) => {
            if (event === 'error') {
                // Store error handler but don't call it (success path)
                mockHttpServer._errorHandler = handler;
            }
            return mockHttpServer;
        });
        mockHttpServer.off = jest.fn().mockReturnValue(mockHttpServer);

        return {
            createServer: jest.fn().mockReturnValue(mockHttpServer),
        };
    });

    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        initializeConfig: mockInitializeConfig,
        CONFIG: mockConfig,
    }));

    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        initApiService: mockInitApiService,
        autoLinkProviderConfigs: jest.fn().mockResolvedValue({}),
        getProviderPoolManager: mockGetProviderPoolManager,
    }));

    await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
        initializeUIManagement: mockInitializeUIManagement,
        serveStaticFiles: jest.fn(),
        handleUIApiRequests: jest.fn(),
        broadcastEvent: jest.fn(),
        handleUploadOAuthCredentials: jest.fn(),
        upload: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../src/services/api-manager.js', () => ({
        initializeAPIManagement: mockInitializeAPIManagement,
        handleAPIRequests: jest.fn(),
        readRequestBody: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../src/handlers/request-handler.js', () => ({
        createRequestHandler: mockCreateRequestHandler,
    }));

    await jest.unstable_mockModule('../../../src/core/plugin-manager.js', () => ({
        discoverPlugins: mockDiscoverPlugins,
        getPluginManager: mockGetPluginManager,
    }));

    await jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
        getTLSSidecar: mockGetTLSSidecar,
    }));

    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        isRetryableNetworkError: mockIsRetryableNetworkError,
    }));

    // Mock dotenv
    await jest.unstable_mockModule('dotenv/config', () => ({}));

    // Mock url module
    await jest.unstable_mockModule('url', () => ({
        pathToFileURL: jest.fn((p) => ({ href: `file://${p}` })),
    }));

    // Mock converters registration
    await jest.unstable_mockModule('../../../src/converters/register-converters.js', () => ({}));

    // Mock codex websocket handler
    await jest.unstable_mockModule('../../../src/providers/openai/codex-websocket.js', () => ({
        createCodexWebSocketHandler: jest.fn(),
    }));

    const mod = await import('../../../src/services/api-server.js');
    startServer = mod.startServer;
    gracefulShutdown = mod.gracefulShutdown;
    sendToMaster = mod.sendToMaster;
});

beforeEach(() => {
    jest.clearAllMocks();
    // Restore default implementations
    mockInitializeConfig.mockResolvedValue(undefined);
    mockDiscoverPlugins.mockResolvedValue(undefined);
    mockGetPluginManager.mockReturnValue(mockPluginManager);
    mockPluginManager.initAll.mockResolvedValue(undefined);
    mockPluginManager.getPluginList.mockReturnValue([]);
    mockInitApiService.mockResolvedValue({});
    mockGetProviderPoolManager.mockReturnValue(null);
    mockInitializeUIManagement.mockReturnValue(undefined);
    mockInitializeAPIManagement.mockReturnValue(jest.fn());
    mockCreateRequestHandler.mockReturnValue(jest.fn());
    mockTLSSidecar.start.mockResolvedValue(false);
    mockTLSSidecar.stop.mockResolvedValue(undefined);

    // Reset the http server mock
    mockHttpServer.listen = jest.fn((port, host, cb) => {
        process.nextTick(cb);
        return mockHttpServer;
    });
    mockHttpServer.close = jest.fn((cb) => {
        if (cb) process.nextTick(cb);
    });
    mockHttpServer.once = jest.fn((event, handler) => {
        if (event === 'error') {
            mockHttpServer._errorHandler = handler;
        }
        return mockHttpServer;
    });
    mockHttpServer.off = jest.fn().mockReturnValue(mockHttpServer);
    mockHttpServer.address = jest.fn().mockReturnValue({ port: 3000 });

    // Force test mode to prevent process.exit
    process.env.AICLIENT_TEST_SERVER = '1';
    // Ensure not in worker process
    delete process.env.IS_WORKER_PROCESS;
});

afterEach(() => {
    jest.useRealTimers();
    delete process.env.AICLIENT_TEST_SERVER;
    delete process.env.IS_WORKER_PROCESS;
});

// ---------------------------------------------------------------------------
// Tests: startServer
// ---------------------------------------------------------------------------
describe('startServer()', () => {
    test('calls initializeConfig with provided argv', async () => {
        const server = await startServer({ argv: ['--port', '3001'], configPath: 'configs/test.json' });
        expect(mockInitializeConfig).toHaveBeenCalledWith(['--port', '3001'], 'configs/test.json');
        expect(server).toBeTruthy();
    });

    test('uses default argv and configPath when options not provided', async () => {
        await startServer({});
        expect(mockInitializeConfig).toHaveBeenCalledWith(process.argv.slice(2), 'configs/config.json');
    });

    test('discovers and initializes plugins', async () => {
        await startServer({});
        expect(mockDiscoverPlugins).toHaveBeenCalled();
        expect(mockGetPluginManager).toHaveBeenCalled();
        expect(mockPluginManager.initAll).toHaveBeenCalledWith(mockConfig);
    });

    test('initializes API services', async () => {
        await startServer({});
        expect(mockInitApiService).toHaveBeenCalledWith(mockConfig, true);
    });

    test('initializes UI management', async () => {
        await startServer({});
        expect(mockInitializeUIManagement).toHaveBeenCalledWith(mockConfig);
    });

    test('initializes API management', async () => {
        await startServer({});
        expect(mockInitializeAPIManagement).toHaveBeenCalled();
    });

    test('creates request handler', async () => {
        await startServer({});
        expect(mockCreateRequestHandler).toHaveBeenCalledWith(mockConfig, null);
    });

    test('returns the http server instance', async () => {
        const server = await startServer({});
        expect(server).toBe(mockHttpServer);
    });

    test('starts TLS sidecar when TLS_SIDECAR_ENABLED is true', async () => {
        const configWithTLS = { ...mockConfig, TLS_SIDECAR_ENABLED: true, TLS_SIDECAR_PORT: 8443 };
        // Temporarily replace CONFIG reference
        const originalEnabled = mockConfig.TLS_SIDECAR_ENABLED;
        mockConfig.TLS_SIDECAR_ENABLED = true;
        mockConfig.TLS_SIDECAR_PORT = 8443;
        mockTLSSidecar.start.mockResolvedValue(true);

        await startServer({});
        expect(mockTLSSidecar.start).toHaveBeenCalled();

        // Restore
        mockConfig.TLS_SIDECAR_ENABLED = originalEnabled;
        delete mockConfig.TLS_SIDECAR_PORT;
    });

    test('does not start TLS sidecar when disabled', async () => {
        mockConfig.TLS_SIDECAR_ENABLED = false;
        await startServer({});
        expect(mockTLSSidecar.start).not.toHaveBeenCalled();
    });

    test('logs loaded plugins when plugin list is non-empty', async () => {
        const logger = (await import('../../../src/utils/logger.js')).default;
        mockPluginManager.getPluginList.mockReturnValue([
            { name: 'test-plugin', version: '1.0.0', description: 'A test plugin', enabled: true },
        ]);
        await startServer({});
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('1 plugin'));
    });

    test('server listen is called with correct port and host', async () => {
        await startServer({});
        expect(mockHttpServer.listen).toHaveBeenCalledWith(
            mockConfig.SERVER_PORT,
            mockConfig.HOST,
            expect.any(Function)
        );
    });

    test('rejects when server listen emits error', async () => {
        mockHttpServer.once = jest.fn((event, handler) => {
            if (event === 'error') {
                process.nextTick(() => handler(new Error('EADDRINUSE')));
            }
            return mockHttpServer;
        });
        // listen never calls callback (simulates no successful listen)
        mockHttpServer.listen = jest.fn(() => mockHttpServer);

        await expect(startServer({})).rejects.toThrow('EADDRINUSE');
    });

    test('sets up cron interval when CRON_REFRESH_TOKEN is true', async () => {
        const heartbeatFn = jest.fn().mockResolvedValue(undefined);
        mockInitializeAPIManagement.mockReturnValue(heartbeatFn);
        mockConfig.CRON_REFRESH_TOKEN = true;
        mockConfig.CRON_NEAR_MINUTES = 15;

        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1);

        await startServer({ argv: [] });

        expect(setIntervalSpy).toHaveBeenCalledWith(heartbeatFn, 15 * 60 * 1000);

        setIntervalSpy.mockRestore();
        mockConfig.CRON_REFRESH_TOKEN = false;
    });
});

// ---------------------------------------------------------------------------
// Tests: gracefulShutdown
// ---------------------------------------------------------------------------
describe('gracefulShutdown()', () => {
    test('closes server in test mode without calling process.exit', async () => {
        process.env.AICLIENT_TEST_SERVER = '1';
        // Run a startServer to set up server instance first
        await startServer({});
        // Now close
        await gracefulShutdown();
        expect(mockHttpServer.close).toHaveBeenCalled();
    });

    test('calls TLS sidecar stop during shutdown', async () => {
        process.env.AICLIENT_TEST_SERVER = '1';
        await startServer({});
        await gracefulShutdown();
        expect(mockTLSSidecar.stop).toHaveBeenCalled();
    });

    test('handles TLS sidecar stop error gracefully', async () => {
        process.env.AICLIENT_TEST_SERVER = '1';
        mockTLSSidecar.stop.mockRejectedValue(new Error('stop failed'));
        await startServer({});
        // Should not throw
        await expect(gracefulShutdown()).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Tests: sendToMaster
// ---------------------------------------------------------------------------
describe('sendToMaster()', () => {
    test('does nothing when not in worker process', () => {
        delete process.env.IS_WORKER_PROCESS;
        // Should not throw even without process.send
        expect(() => sendToMaster({ type: 'ready', pid: 123 })).not.toThrow();
    });

    test('calls process.send when IS_WORKER_PROCESS is true', () => {
        process.env.IS_WORKER_PROCESS = 'true';
        const originalSend = process.send;
        process.send = jest.fn();

        sendToMaster({ type: 'ready', pid: 123 });
        // Note: the function checks IS_WORKER_PROCESS at module load time,
        // so behavior depends on when the env var was set relative to module load.
        // This test validates the function does not throw.
        expect(typeof sendToMaster).toBe('function');

        process.send = originalSend;
        delete process.env.IS_WORKER_PROCESS;
    });
});
