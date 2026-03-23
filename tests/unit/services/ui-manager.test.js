/**
 * Unit tests for services/ui-manager.js
 *
 * Tests: serveStaticFiles (file found / not found / content types),
 *        handleUIApiRequests (auth, routing, CORS 401 response).
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Controllable mock state
// ---------------------------------------------------------------------------
let mockExistsSync = jest.fn().mockReturnValue(false);
let mockReadFileSync = jest.fn().mockReturnValue(Buffer.from('file-content'));

// Auth module mocks
const mockHandleLoginRequest = jest.fn();
const mockCheckAuth = jest.fn();

// System API mocks
const mockHandleHealthCheck = jest.fn();
const mockHandleGetSystem = jest.fn();
const mockHandleDownloadTodayLog = jest.fn();
const mockHandleClearTodayLog = jest.fn();
const mockHandleRestartService = jest.fn();
const mockHandleGetServiceMode = jest.fn();

// Config API mocks
const mockHandleUpdateAdminPassword = jest.fn();
const mockHandleGetConfig = jest.fn();
const mockHandleUpdateConfig = jest.fn();
const mockHandleReloadConfig = jest.fn();

// Provider API mocks
const mockHandleGetProviders = jest.fn();
const mockHandleGetSupportedProviders = jest.fn();
const mockHandleGetProviderType = jest.fn();
const mockHandleGetProviderModels = jest.fn();
const mockHandleGetProviderTypeModels = jest.fn();
const mockHandleAddProvider = jest.fn();
const mockHandleResetProviderHealth = jest.fn();
const mockHandleHealthCheckProvider = jest.fn();
const mockHandleDeleteUnhealthyProviders = jest.fn();
const mockHandleRefreshUnhealthyUuids = jest.fn();
const mockHandleDisableEnableProvider = jest.fn();
const mockHandleRefreshProviderUuid = jest.fn();
const mockHandleUpdateProvider = jest.fn();
const mockHandleDeleteProvider = jest.fn();
const mockHandleQuickLinkProvider = jest.fn();

// Usage API mocks
const mockHandleGetUsage = jest.fn();
const mockHandleGetSupportedProvidersUsage = jest.fn();
const mockHandleGetProviderUsage = jest.fn();

// Upload config API mocks
const mockHandleGetUploadConfigs = jest.fn();
const mockHandleViewConfigFile = jest.fn();
const mockHandleDownloadConfigFile = jest.fn();
const mockHandleDeleteConfigFile = jest.fn();
const mockHandleDownloadAllConfigs = jest.fn();
const mockHandleDeleteUnboundConfigs = jest.fn();

// OAuth API mocks
const mockHandleGenerateAuthUrl = jest.fn();
const mockHandleManualOAuthCallback = jest.fn();
const mockHandleBatchImportKiroTokens = jest.fn();
const mockHandleBatchImportGeminiTokens = jest.fn();
const mockHandleBatchImportCodexTokens = jest.fn();
const mockHandleImportAwsCredentials = jest.fn();

// Update API mocks
const mockHandleCheckUpdate = jest.fn();
const mockHandlePerformUpdate = jest.fn();

// Plugin API mocks
const mockHandleGetPlugins = jest.fn();
const mockHandleTogglePlugin = jest.fn();

// Event broadcast mocks
const mockBroadcastEvent = jest.fn();
const mockInitializeUIManagement = jest.fn();
const mockHandleUploadOAuthCredentials = jest.fn();
const mockUpload = jest.fn();
const mockHandleEvents = jest.fn();

// ---------------------------------------------------------------------------
// Module references
// ---------------------------------------------------------------------------
let serveStaticFiles;
let handleUIApiRequests;

beforeAll(async () => {
    await jest.unstable_mockModule('fs', () => ({
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
        promises: {},
    }));

    await jest.unstable_mockModule('path', async () => {
        const actual = await import('node:path');
        return {
            default: actual,
            ...actual,
        };
    });

    await jest.unstable_mockModule('../../../src/ui-modules/auth.js', () => ({
        handleLoginRequest: mockHandleLoginRequest,
        checkAuth: mockCheckAuth,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/system-api.js', () => ({
        handleHealthCheck: mockHandleHealthCheck,
        handleGetSystem: mockHandleGetSystem,
        handleDownloadTodayLog: mockHandleDownloadTodayLog,
        handleClearTodayLog: mockHandleClearTodayLog,
        handleRestartService: mockHandleRestartService,
        handleGetServiceMode: mockHandleGetServiceMode,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/config-api.js', () => ({
        handleUpdateAdminPassword: mockHandleUpdateAdminPassword,
        handleGetConfig: mockHandleGetConfig,
        handleUpdateConfig: mockHandleUpdateConfig,
        handleReloadConfig: mockHandleReloadConfig,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/provider-api.js', () => ({
        handleGetProviders: mockHandleGetProviders,
        handleGetSupportedProviders: mockHandleGetSupportedProviders,
        handleGetProviderType: mockHandleGetProviderType,
        handleGetProviderModels: mockHandleGetProviderModels,
        handleGetProviderTypeModels: mockHandleGetProviderTypeModels,
        handleAddProvider: mockHandleAddProvider,
        handleResetProviderHealth: mockHandleResetProviderHealth,
        handleHealthCheck: mockHandleHealthCheckProvider,
        handleDeleteUnhealthyProviders: mockHandleDeleteUnhealthyProviders,
        handleRefreshUnhealthyUuids: mockHandleRefreshUnhealthyUuids,
        handleDisableEnableProvider: mockHandleDisableEnableProvider,
        handleRefreshProviderUuid: mockHandleRefreshProviderUuid,
        handleUpdateProvider: mockHandleUpdateProvider,
        handleDeleteProvider: mockHandleDeleteProvider,
        handleQuickLinkProvider: mockHandleQuickLinkProvider,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/usage-api.js', () => ({
        handleGetUsage: mockHandleGetUsage,
        handleGetSupportedProviders: mockHandleGetSupportedProvidersUsage,
        handleGetProviderUsage: mockHandleGetProviderUsage,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/upload-config-api.js', () => ({
        handleGetUploadConfigs: mockHandleGetUploadConfigs,
        handleViewConfigFile: mockHandleViewConfigFile,
        handleDownloadConfigFile: mockHandleDownloadConfigFile,
        handleDeleteConfigFile: mockHandleDeleteConfigFile,
        handleDownloadAllConfigs: mockHandleDownloadAllConfigs,
        handleDeleteUnboundConfigs: mockHandleDeleteUnboundConfigs,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/oauth-api.js', () => ({
        handleGenerateAuthUrl: mockHandleGenerateAuthUrl,
        handleManualOAuthCallback: mockHandleManualOAuthCallback,
        handleBatchImportKiroTokens: mockHandleBatchImportKiroTokens,
        handleBatchImportGeminiTokens: mockHandleBatchImportGeminiTokens,
        handleBatchImportCodexTokens: mockHandleBatchImportCodexTokens,
        handleImportAwsCredentials: mockHandleImportAwsCredentials,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/update-api.js', () => ({
        handleCheckUpdate: mockHandleCheckUpdate,
        handlePerformUpdate: mockHandlePerformUpdate,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/plugin-api.js', () => ({
        handleGetPlugins: mockHandleGetPlugins,
        handleTogglePlugin: mockHandleTogglePlugin,
    }));

    await jest.unstable_mockModule('../../../src/ui-modules/event-broadcast.js', () => ({
        broadcastEvent: mockBroadcastEvent,
        initializeUIManagement: mockInitializeUIManagement,
        handleUploadOAuthCredentials: mockHandleUploadOAuthCredentials,
        upload: mockUpload,
        handleEvents: mockHandleEvents,
    }));

    const mod = await import('../../../src/services/ui-manager.js');
    serveStaticFiles = mod.serveStaticFiles;
    handleUIApiRequests = mod.handleUIApiRequests;
});

beforeEach(() => {
    jest.clearAllMocks();
    // Default: file not found
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue(Buffer.from('file-content'));
    // Default auth: authorized
    mockCheckAuth.mockResolvedValue(true);
    // Default handlers return true (handled)
    mockHandleLoginRequest.mockResolvedValue(true);
    mockHandleHealthCheck.mockResolvedValue(true);
    mockHandleGetSystem.mockResolvedValue(true);
    mockHandleGetConfig.mockResolvedValue(true);
    mockHandleUpdateConfig.mockResolvedValue(true);
    mockHandleGetProviders.mockResolvedValue(true);
    mockHandleGetSupportedProviders.mockResolvedValue(true);
    mockHandleGetUsage.mockResolvedValue(true);
    mockHandleCheckUpdate.mockResolvedValue(true);
    mockHandlePerformUpdate.mockResolvedValue(true);
    mockHandleGetPlugins.mockResolvedValue(true);
    mockHandleUploadOAuthCredentials.mockResolvedValue(true);
    mockHandleUpdateAdminPassword.mockResolvedValue(true);
    mockHandleReloadConfig.mockResolvedValue(true);
    mockHandleRestartService.mockResolvedValue(true);
    mockHandleGetServiceMode.mockResolvedValue(true);
    mockHandleEvents.mockResolvedValue(true);
    mockHandleManualOAuthCallback.mockResolvedValue(true);
    mockHandleGetSupportedProvidersUsage.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeMockRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
        setHeader: jest.fn(),
    };
}

function makeMockReq() {
    return {};
}

// ---------------------------------------------------------------------------
// Tests: serveStaticFiles
// ---------------------------------------------------------------------------
describe('serveStaticFiles()', () => {
    test('returns false when file does not exist', async () => {
        mockExistsSync.mockReturnValue(false);
        const res = makeMockRes();
        const result = await serveStaticFiles('/nonexistent.html', res);
        expect(result).toBe(false);
        expect(res.writeHead).not.toHaveBeenCalled();
    });

    test('returns true and sends file when it exists', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(Buffer.from('<html></html>'));
        const res = makeMockRes();
        const result = await serveStaticFiles('/index.html', res);
        expect(result).toBe(true);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/html' }));
        expect(res.end).toHaveBeenCalled();
    });

    test('serves / as index.html with text/html content type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(Buffer.from('<html></html>'));
        const res = makeMockRes();
        await serveStaticFiles('/', res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/html' }));
    });

    test('serves .css files with text/css content type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(Buffer.from('body {}'));
        const res = makeMockRes();
        await serveStaticFiles('/style.css', res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/css' }));
    });

    test('serves .js files with application/javascript content type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(Buffer.from('var x = 1;'));
        const res = makeMockRes();
        await serveStaticFiles('/app.js', res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'application/javascript' }));
    });

    test('serves .png files with image/png content type', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(Buffer.from('PNG'));
        const res = makeMockRes();
        await serveStaticFiles('/image.png', res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'image/png' }));
    });

    test('falls back to text/plain for unknown extensions', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(Buffer.from('data'));
        const res = makeMockRes();
        await serveStaticFiles('/file.xyz', res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/plain' }));
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — login (public endpoint)
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — POST /api/login', () => {
    test('calls handleLoginRequest and returns result without auth check', async () => {
        const req = makeMockReq();
        const res = makeMockRes();
        mockHandleLoginRequest.mockResolvedValue(true);

        const result = await handleUIApiRequests('POST', '/api/login', req, res, {}, null);
        expect(mockHandleLoginRequest).toHaveBeenCalledWith(req, res);
        expect(result).toBe(true);
        // Login endpoint should NOT check auth
        expect(mockCheckAuth).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — health (public endpoint)
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — GET /api/health', () => {
    test('calls handleHealthCheck without auth check', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/health', req, res, {}, null);
        expect(mockHandleHealthCheck).toHaveBeenCalledWith(req, res);
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — 401 unauthorized
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — authentication', () => {
    test('returns 401 when auth check fails for protected endpoints', async () => {
        mockCheckAuth.mockResolvedValue(false);
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/config', req, res, {}, null);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
        expect(res.end).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('does not call protected handler when unauthorized', async () => {
        mockCheckAuth.mockResolvedValue(false);
        const req = makeMockReq();
        const res = makeMockRes();

        await handleUIApiRequests('GET', '/api/config', req, res, {}, null);
        expect(mockHandleGetConfig).not.toHaveBeenCalled();
    });

    test('calls protected handler when authorized', async () => {
        mockCheckAuth.mockResolvedValue(true);
        const req = makeMockReq();
        const res = makeMockRes();

        await handleUIApiRequests('GET', '/api/config', req, res, { someConfig: true }, null);
        expect(mockHandleGetConfig).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — config routes
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — config routes', () => {
    test('GET /api/config calls handleGetConfig', async () => {
        const req = makeMockReq();
        const res = makeMockRes();
        const config = { SERVER_PORT: 3000 };

        const result = await handleUIApiRequests('GET', '/api/config', req, res, config, null);
        expect(mockHandleGetConfig).toHaveBeenCalledWith(req, res, config);
        expect(result).toBe(true);
    });

    test('POST /api/config calls handleUpdateConfig', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/config', req, res, {}, null);
        expect(mockHandleUpdateConfig).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/admin-password calls handleUpdateAdminPassword', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/admin-password', req, res, {}, null);
        expect(mockHandleUpdateAdminPassword).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/reload-config calls handleReloadConfig', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/reload-config', req, res, {}, null);
        expect(mockHandleReloadConfig).toHaveBeenCalled();
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — provider routes
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — provider routes', () => {
    test('GET /api/providers calls handleGetProviders', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/providers', req, res, {}, null);
        expect(mockHandleGetProviders).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('GET /api/providers/supported calls handleGetSupportedProviders', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/providers/supported', req, res, {}, null);
        expect(mockHandleGetSupportedProviders).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/providers calls handleAddProvider', async () => {
        mockHandleAddProvider.mockResolvedValue(true);
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/providers', req, res, {}, null);
        expect(mockHandleAddProvider).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('GET /api/providers/:type calls handleGetProviderType', async () => {
        mockHandleGetProviderType.mockResolvedValue(true);
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/providers/openai-custom', req, res, {}, null);
        expect(mockHandleGetProviderType).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/providers/:type/reset-health calls handleResetProviderHealth', async () => {
        mockHandleResetProviderHealth.mockResolvedValue(true);
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/providers/openai-custom/reset-health', req, res, {}, null);
        expect(mockHandleResetProviderHealth).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/providers/:type/health-check calls handleHealthCheck', async () => {
        mockHandleHealthCheckProvider.mockResolvedValue(true);
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/providers/openai-custom/health-check', req, res, {}, null);
        expect(mockHandleHealthCheckProvider).toHaveBeenCalled();
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — system routes
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — system routes', () => {
    test('GET /api/system calls handleGetSystem', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/system', req, res, {}, null);
        expect(mockHandleGetSystem).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/restart-service calls handleRestartService', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/restart-service', req, res, {}, null);
        expect(mockHandleRestartService).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('GET /api/service-mode calls handleGetServiceMode', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/service-mode', req, res, {}, null);
        expect(mockHandleGetServiceMode).toHaveBeenCalled();
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — update routes
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — update routes', () => {
    test('GET /api/check-update calls handleCheckUpdate', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/check-update', req, res, {}, null);
        expect(mockHandleCheckUpdate).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/update calls handlePerformUpdate', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/update', req, res, {}, null);
        expect(mockHandlePerformUpdate).toHaveBeenCalled();
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — plugin routes
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — plugin routes', () => {
    test('GET /api/plugins calls handleGetPlugins', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/plugins', req, res, {}, null);
        expect(mockHandleGetPlugins).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/plugins/:name/toggle calls handleTogglePlugin', async () => {
        mockHandleTogglePlugin.mockResolvedValue(true);
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/plugins/my-plugin/toggle', req, res, {}, null);
        expect(mockHandleTogglePlugin).toHaveBeenCalledWith(req, res, 'my-plugin');
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — usage routes
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — usage routes', () => {
    test('GET /api/usage calls handleGetUsage', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/usage', req, res, {}, null);
        expect(mockHandleGetUsage).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('GET /api/usage/supported-providers calls handleGetSupportedProvidersUsage', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/usage/supported-providers', req, res, {}, null);
        expect(mockHandleGetSupportedProvidersUsage).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('GET /api/usage/:type calls handleGetProviderUsage', async () => {
        mockHandleGetProviderUsage.mockResolvedValue(true);
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/usage/openai-custom', req, res, {}, null);
        expect(mockHandleGetProviderUsage).toHaveBeenCalled();
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — events route (no auth required)
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — events route', () => {
    test('GET /api/events calls handleEvents without requiring auth check', async () => {
        mockCheckAuth.mockResolvedValue(false); // even with failed auth
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/events', req, res, {}, null);
        expect(mockHandleEvents).toHaveBeenCalled();
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — OAuth routes
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — OAuth routes', () => {
    test('POST /api/oauth/manual-callback calls handleManualOAuthCallback', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/oauth/manual-callback', req, res, {}, null);
        expect(mockHandleManualOAuthCallback).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    test('POST /api/kiro/batch-import-tokens calls handleBatchImportKiroTokens', async () => {
        mockHandleBatchImportKiroTokens.mockResolvedValue(true);
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/kiro/batch-import-tokens', req, res, {}, null);
        expect(mockHandleBatchImportKiroTokens).toHaveBeenCalled();
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — upload route (no auth required at handler level)
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — upload route', () => {
    test('POST /api/upload-oauth-credentials calls handleUploadOAuthCredentials', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('POST', '/api/upload-oauth-credentials', req, res, {}, null);
        expect(mockHandleUploadOAuthCredentials).toHaveBeenCalled();
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Tests: handleUIApiRequests — unhandled routes
// ---------------------------------------------------------------------------
describe('handleUIApiRequests — unhandled routes', () => {
    test('returns false for unknown path', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/api/unknown-endpoint', req, res, {}, null);
        expect(result).toBe(false);
    });

    test('returns false for non-api path', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        const result = await handleUIApiRequests('GET', '/v1/chat/completions', req, res, {}, null);
        expect(result).toBe(false);
    });
});
