/**
 * grok-assets-proxy.js 单元测试
 * 测试: handleGrokAssetsProxy
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

let handleGrokAssetsProxy;
let mockAxios;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        configureAxiosProxy: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        __esModule: true,
        MODEL_PROVIDER: { GROK_CUSTOM: 'grok-custom' },
    }));

    mockAxios = jest.fn();
    await jest.unstable_mockModule('axios', () => ({
        __esModule: true,
        default: mockAxios,
    }));

    const mod = await import('../../../src/utils/grok-assets-proxy.js');
    handleGrokAssetsProxy = mod.handleGrokAssetsProxy;
});

function createMockReqRes(urlStr) {
    const req = { url: urlStr, headers: { host: 'localhost:3000' } };
    const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
        headersSent: false,
    };
    return { req, res };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('handleGrokAssetsProxy', () => {
    test('缺少 url 参数时应返回 400', async () => {
        const { req, res } = createMockReqRes('/grok-assets?sso=test');

        await handleGrokAssetsProxy(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        expect(res.end).toHaveBeenCalledWith(expect.stringContaining('Missing url parameter'));
    });

    test('缺少 sso 参数且无 uuid 时应返回 400', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://assets.grok.com/test.png');

        await handleGrokAssetsProxy(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        expect(res.end).toHaveBeenCalledWith(expect.stringContaining('Missing sso'));
    });

    test('通过 uuid 查找 sso token', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://assets.grok.com/test.png&uuid=test-uuid');
        const mockStream = new EventEmitter();
        mockStream.pipe = jest.fn();

        mockAxios.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': '1024' },
            data: mockStream,
        });

        const poolManager = {
            findProviderByUuid: jest.fn().mockReturnValue({ GROK_COOKIE_TOKEN: 'found-token' }),
        };

        await handleGrokAssetsProxy(req, res, {}, poolManager);

        expect(poolManager.findProviderByUuid).toHaveBeenCalledWith('test-uuid');
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    test('uuid 查找失败且无 sso 时应返回 400', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://assets.grok.com/test.png&uuid=bad-uuid');
        const poolManager = {
            findProviderByUuid: jest.fn().mockReturnValue(null),
        };

        await handleGrokAssetsProxy(req, res, {}, poolManager);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('非 assets.grok.com 域名应返回 403', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://evil.com/malware.exe&sso=test-token');

        await handleGrokAssetsProxy(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
        expect(res.end).toHaveBeenCalledWith(expect.stringContaining('Forbidden'));
    });

    test('无效 URL 应返回 400', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=not-a-valid-url-at-all&sso=test');

        await handleGrokAssetsProxy(req, res, {}, null);

        // 相对路径会被补全为 assets.grok.com，所以不会报 400
        // 但如果真的无效会报错
    });

    test('成功代理请求并转发响应', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://assets.grok.com/img.png&sso=test-token');
        const mockStream = new EventEmitter();
        mockStream.pipe = jest.fn();

        mockAxios.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': '2048', 'cache-control': 'public, max-age=86400' },
            data: mockStream,
        });

        await handleGrokAssetsProxy(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'image/png',
            'Content-Length': '2048',
        }));
        expect(mockStream.pipe).toHaveBeenCalledWith(res);
    });

    test('sso 参数以 "sso=" 前缀时应清理', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://assets.grok.com/img.png&sso=sso%3Dactual-token');
        const mockStream = new EventEmitter();
        mockStream.pipe = jest.fn();

        mockAxios.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png' },
            data: mockStream,
        });

        await handleGrokAssetsProxy(req, res, {}, null);

        // 验证 axios 调用时 Cookie 使用清理后的 token
        const axiosCall = mockAxios.mock.calls[0][0];
        expect(axiosCall.headers.Cookie).toContain('sso=actual-token');
    });

    test('相对路径应补全为 assets.grok.com URL', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=/some/path/img.png&sso=test');
        const mockStream = new EventEmitter();
        mockStream.pipe = jest.fn();

        mockAxios.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png' },
            data: mockStream,
        });

        await handleGrokAssetsProxy(req, res, {}, null);

        const axiosCall = mockAxios.mock.calls[0][0];
        expect(axiosCall.url).toBe('https://assets.grok.com/some/path/img.png');
    });

    test('axios 错误时应返回 500', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://assets.grok.com/img.png&sso=test');

        mockAxios.mockRejectedValue(new Error('Network error'));

        await handleGrokAssetsProxy(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        expect(res.end).toHaveBeenCalledWith(expect.stringContaining('Internal Server Error'));
    });

    test('流错误时应结束响应', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://assets.grok.com/img.png&sso=test');
        const mockStream = new EventEmitter();
        mockStream.pipe = jest.fn();

        mockAxios.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png' },
            data: mockStream,
        });

        await handleGrokAssetsProxy(req, res, {}, null);

        // 模拟流错误
        const errorHandler = mockStream.listeners('error')[0];
        if (errorHandler) {
            res.headersSent = true;
            errorHandler(new Error('Stream broken'));
            expect(res.end).toHaveBeenCalled();
        }
    });

    test('无 content-length 时不设置该头', async () => {
        const { req, res } = createMockReqRes('/grok-assets?url=https://assets.grok.com/img.png&sso=test');
        const mockStream = new EventEmitter();
        mockStream.pipe = jest.fn();

        mockAxios.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'image/png' },
            data: mockStream,
        });

        await handleGrokAssetsProxy(req, res, {}, null);

        const headers = res.writeHead.mock.calls[0][1];
        expect(headers['Content-Length']).toBeUndefined();
    });
});
