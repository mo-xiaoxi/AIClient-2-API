/**
 * iflow-oauth.js 单元测试
 * 测试: handleIFlowOAuth, refreshIFlowTokens
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let handleIFlowOAuth;
let refreshIFlowTokens;

let mockBroadcastEvent;
let mockAutoLinkProviderConfigs;
let mockAxiosInstance;
let mockHttpServer;
let mockFsMkdir;
let mockFsWriteFile;

beforeAll(async () => {
    mockBroadcastEvent = jest.fn();
    mockAutoLinkProviderConfigs = jest.fn().mockResolvedValue(undefined);
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);

    mockAxiosInstance = jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'openid' },
        headers: {},
    });

    mockHttpServer = {
        listen: jest.fn(function (...args) {
            const cb = args.find(a => typeof a === 'function');
            if (cb) cb();
        }),
        close: jest.fn(function (cb) { if (cb) cb(); }),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
        listening: true,
    };

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/services/ui-manager.js', () => ({
        __esModule: true,
        broadcastEvent: mockBroadcastEvent,
    }));

    await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
        __esModule: true,
        autoLinkProviderConfigs: mockAutoLinkProviderConfigs,
    }));

    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        __esModule: true,
        CONFIG: {},
    }));

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        getProxyConfigForProvider: jest.fn().mockReturnValue(null),
    }));

    await jest.unstable_mockModule('axios', () => ({
        __esModule: true,
        default: Object.assign(mockAxiosInstance, {
            create: jest.fn().mockReturnValue(mockAxiosInstance),
        }),
    }));

    await jest.unstable_mockModule('http', () => ({
        __esModule: true,
        default: {
            createServer: jest.fn().mockReturnValue(mockHttpServer),
        },
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        default: {
            promises: {
                mkdir: mockFsMkdir,
                writeFile: mockFsWriteFile,
            },
        },
    }));

    const mod = await import('../../../src/auth/iflow-oauth.js');
    handleIFlowOAuth = mod.handleIFlowOAuth;
    refreshIFlowTokens = mod.refreshIFlowTokens;
});

beforeEach(() => {
    jest.clearAllMocks();

    // 默认的成功 token 响应
    mockAxiosInstance.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'openid',
        },
        headers: {},
    });
});

describe('handleIFlowOAuth', () => {
    test('应返回授权 URL 和 authInfo', async () => {
        const result = await handleIFlowOAuth({});

        expect(result).toHaveProperty('authUrl');
        expect(result).toHaveProperty('authInfo');
        expect(result.authInfo.provider).toBe('openai-iflow');
        expect(result.authUrl).toContain('iflow.cn/oauth');
        expect(result.authInfo.callbackPort).toBe(8087);
        expect(result.authInfo.state).toBeDefined();
    });

    test('应支持自定义端口', async () => {
        const result = await handleIFlowOAuth({}, { port: 9999 });

        expect(result.authInfo.callbackPort).toBe(9999);
    });

    test('应包含 redirectUri', async () => {
        const result = await handleIFlowOAuth({});

        expect(result.authInfo.redirectUri).toContain('oauth2callback');
    });

    test('授权 URL 应包含 client_id', async () => {
        const result = await handleIFlowOAuth({});

        expect(result.authUrl).toContain('client_id=');
    });

    test('授权 URL 应包含 state 参数', async () => {
        const result = await handleIFlowOAuth({});

        expect(result.authUrl).toContain('state=');
    });

    test('当服务器启动失败时应抛出错误', async () => {
        const http = await import('http');
        http.default.createServer.mockReturnValue({
            listen: jest.fn(function (...args) {
                // 不调用回调，而是触发 error
            }),
            close: jest.fn((cb) => { if (cb) cb(); }),
            on: jest.fn(function (event, cb) {
                if (event === 'error') {
                    // 模拟端口被占用
                    setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
                }
            }),
            listening: false,
        });

        await expect(handleIFlowOAuth({})).rejects.toThrow();
    });
});

describe('refreshIFlowTokens', () => {
    test('应成功刷新令牌', async () => {
        // 第一次调用 - token refresh
        // 第二次调用 - user info
        let callCount = 0;
        mockAxiosInstance.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    status: 200,
                    statusText: 'OK',
                    data: {
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token',
                        expires_in: 3600,
                        token_type: 'Bearer',
                        scope: 'openid',
                    },
                    headers: {},
                };
            }
            // user info 调用
            return {
                status: 200,
                statusText: 'OK',
                data: {
                    success: true,
                    data: {
                        apiKey: 'test-api-key',
                        email: 'test@example.com',
                        phone: '13800138000',
                    },
                },
                headers: {},
            };
        });

        const result = await refreshIFlowTokens('old-refresh-token');

        expect(result.access_token).toBe('new-access-token');
        expect(result.refresh_token).toBe('new-refresh-token');
        expect(result.apiKey).toBe('test-api-key');
        expect(result.expiry_date).toBeGreaterThan(Date.now());
    });

    test('token 刷新失败时应抛出错误', async () => {
        mockAxiosInstance.mockResolvedValue({
            status: 401,
            statusText: 'Unauthorized',
            data: 'Invalid refresh token',
            headers: {},
        });

        await expect(refreshIFlowTokens('invalid-token'))
            .rejects.toThrow('iFlow token refresh failed');
    });

    test('响应中缺少 access_token 时应抛出错误', async () => {
        mockAxiosInstance.mockResolvedValue({
            status: 200,
            statusText: 'OK',
            data: { refresh_token: 'only-refresh' },
            headers: {},
        });

        await expect(refreshIFlowTokens('some-token'))
            .rejects.toThrow('missing access token');
    });

    test('获取用户信息失败时应抛出错误', async () => {
        let callCount = 0;
        mockAxiosInstance.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    status: 200,
                    statusText: 'OK',
                    data: {
                        access_token: 'new-access',
                        refresh_token: 'new-refresh',
                        expires_in: 3600,
                    },
                    headers: {},
                };
            }
            // user info 失败
            return {
                status: 200,
                statusText: 'OK',
                data: { success: false },
                headers: {},
            };
        });

        await expect(refreshIFlowTokens('some-token'))
            .rejects.toThrow('request not successful');
    });

    test('用户信息缺少 apiKey 时应抛出错误', async () => {
        let callCount = 0;
        mockAxiosInstance.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    status: 200,
                    statusText: 'OK',
                    data: {
                        access_token: 'new-access',
                        refresh_token: 'new-refresh',
                        expires_in: 3600,
                    },
                    headers: {},
                };
            }
            return {
                status: 200,
                statusText: 'OK',
                data: { success: true, data: { email: 'test@example.com' } },
                headers: {},
            };
        });

        await expect(refreshIFlowTokens('some-token'))
            .rejects.toThrow('missing api key');
    });

    test('用户信息缺少 email 和 phone 时应抛出错误', async () => {
        let callCount = 0;
        mockAxiosInstance.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    status: 200,
                    statusText: 'OK',
                    data: {
                        access_token: 'new-access',
                        refresh_token: 'new-refresh',
                        expires_in: 3600,
                    },
                    headers: {},
                };
            }
            return {
                status: 200,
                statusText: 'OK',
                data: { success: true, data: { apiKey: 'key123', email: '', phone: '' } },
                headers: {},
            };
        });

        await expect(refreshIFlowTokens('some-token'))
            .rejects.toThrow('missing account email/phone');
    });

    test('空 accessToken 获取用户信息时应抛出错误', async () => {
        let callCount = 0;
        mockAxiosInstance.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    status: 200,
                    statusText: 'OK',
                    data: {
                        access_token: '',
                        refresh_token: 'new-refresh',
                        expires_in: 3600,
                    },
                    headers: {},
                };
            }
            throw new Error('should not reach here');
        });

        await expect(refreshIFlowTokens('some-token'))
            .rejects.toThrow('missing access token');
    });
});
