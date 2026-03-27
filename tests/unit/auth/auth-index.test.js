/**
 * auth/index.js 单元测试
 * 验证所有 OAuth 模块正确导出
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

let authModule;

beforeAll(async () => {
    // Mock 所有依赖模块
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
        __esModule: true,
        broadcastEvent: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        __esModule: true,
        autoLinkProviderConfigs: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        __esModule: true,
        CONFIG: {},
    }));

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        getProxyConfigForProvider: jest.fn().mockReturnValue(null),
        getGoogleAuthProxyConfig: jest.fn().mockReturnValue(null),
        configureAxiosProxy: jest.fn(),
    }));

    await jest.unstable_mockModule('axios', () => ({
        __esModule: true,
        default: jest.fn(),
    }));

    await jest.unstable_mockModule('open', () => ({
        __esModule: true,
        default: jest.fn(),
    }));

    await jest.unstable_mockModule('os', () => ({
        hostname: jest.fn().mockReturnValue('test-host'),
        default: { hostname: jest.fn().mockReturnValue('test-host') },
    }));

    await jest.unstable_mockModule('http', () => ({
        __esModule: true,
        default: {
            createServer: jest.fn().mockReturnValue({
                listen: jest.fn((p, h, cb) => { if (cb) cb(); else if (typeof h === 'function') h(); }),
                close: jest.fn((cb) => { if (cb) cb(); }),
                on: jest.fn(),
            }),
        },
    }));

    const fsMockPromises = {
        mkdir: jest.fn().mockResolvedValue(undefined),
        writeFile: jest.fn().mockResolvedValue(undefined),
        readFile: jest.fn().mockResolvedValue('{}'),
        readdir: jest.fn().mockResolvedValue([]),
    };
    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        default: {
            existsSync: jest.fn().mockReturnValue(false),
            promises: fsMockPromises,
        },
        promises: fsMockPromises,
        existsSync: jest.fn().mockReturnValue(false),
    }));

    authModule = await import('../../../src/auth/index.js');
});

describe('auth/index.js 导出验证', () => {
    // Codex OAuth
    test('应导出 refreshCodexTokensWithRetry', () => {
        expect(authModule.refreshCodexTokensWithRetry).toBeDefined();
        expect(typeof authModule.refreshCodexTokensWithRetry).toBe('function');
    });

    test('应导出 handleCodexOAuth', () => {
        expect(authModule.handleCodexOAuth).toBeDefined();
        expect(typeof authModule.handleCodexOAuth).toBe('function');
    });

    test('应导出 handleCodexOAuthCallback', () => {
        expect(authModule.handleCodexOAuthCallback).toBeDefined();
        expect(typeof authModule.handleCodexOAuthCallback).toBe('function');
    });

    test('应导出 batchImportCodexTokensStream', () => {
        expect(authModule.batchImportCodexTokensStream).toBeDefined();
        expect(typeof authModule.batchImportCodexTokensStream).toBe('function');
    });

    // Gemini OAuth
    test('应导出 handleGeminiCliOAuth', () => {
        expect(authModule.handleGeminiCliOAuth).toBeDefined();
        expect(typeof authModule.handleGeminiCliOAuth).toBe('function');
    });

    test('应导出 handleGeminiAntigravityOAuth', () => {
        expect(authModule.handleGeminiAntigravityOAuth).toBeDefined();
        expect(typeof authModule.handleGeminiAntigravityOAuth).toBe('function');
    });

    test('应导出 batchImportGeminiTokensStream', () => {
        expect(authModule.batchImportGeminiTokensStream).toBeDefined();
        expect(typeof authModule.batchImportGeminiTokensStream).toBe('function');
    });

    test('应导出 checkGeminiCredentialsDuplicate', () => {
        expect(authModule.checkGeminiCredentialsDuplicate).toBeDefined();
        expect(typeof authModule.checkGeminiCredentialsDuplicate).toBe('function');
    });

    // Qwen OAuth
    test('应导出 handleQwenOAuth', () => {
        expect(authModule.handleQwenOAuth).toBeDefined();
        expect(typeof authModule.handleQwenOAuth).toBe('function');
    });

    // Kiro OAuth
    test('应导出 handleKiroOAuth', () => {
        expect(authModule.handleKiroOAuth).toBeDefined();
        expect(typeof authModule.handleKiroOAuth).toBe('function');
    });

    test('应导出 checkKiroCredentialsDuplicate', () => {
        expect(authModule.checkKiroCredentialsDuplicate).toBeDefined();
        expect(typeof authModule.checkKiroCredentialsDuplicate).toBe('function');
    });

    test('应导出 batchImportKiroRefreshTokens', () => {
        expect(authModule.batchImportKiroRefreshTokens).toBeDefined();
        expect(typeof authModule.batchImportKiroRefreshTokens).toBe('function');
    });

    test('应导出 batchImportKiroRefreshTokensStream', () => {
        expect(authModule.batchImportKiroRefreshTokensStream).toBeDefined();
        expect(typeof authModule.batchImportKiroRefreshTokensStream).toBe('function');
    });

    test('应导出 importAwsCredentials', () => {
        expect(authModule.importAwsCredentials).toBeDefined();
        expect(typeof authModule.importAwsCredentials).toBe('function');
    });

    // iFlow OAuth
    test('应导出 handleIFlowOAuth', () => {
        expect(authModule.handleIFlowOAuth).toBeDefined();
        expect(typeof authModule.handleIFlowOAuth).toBe('function');
    });

    test('应导出 refreshIFlowTokens', () => {
        expect(authModule.refreshIFlowTokens).toBeDefined();
        expect(typeof authModule.refreshIFlowTokens).toBe('function');
    });

    // Cursor OAuth
    test('应导出 handleCursorOAuth', () => {
        expect(authModule.handleCursorOAuth).toBeDefined();
        expect(typeof authModule.handleCursorOAuth).toBe('function');
    });

    test('应导出 generateCursorAuthParams', () => {
        expect(authModule.generateCursorAuthParams).toBeDefined();
        expect(typeof authModule.generateCursorAuthParams).toBe('function');
    });

    test('应导出 refreshCursorToken', () => {
        expect(authModule.refreshCursorToken).toBeDefined();
        expect(typeof authModule.refreshCursorToken).toBe('function');
    });
});
