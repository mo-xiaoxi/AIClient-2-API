/**
 * Unit tests for src/providers/openai/iflow-core.js — exported helpers + IFlowApiService basics.
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
}));

await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

await jest.unstable_mockModule('axios', () => ({
    default: {
        create: jest.fn(() => ({ defaults: { headers: {} }, request: jest.fn() })),
        request: jest.fn(),
    },
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    isRetryableNetworkError: jest.fn(() => false),
    MODEL_PROVIDER: { IFLOW_API: 'openai-iflow' },
    formatExpiryLog: jest.fn(() => ({ message: '', isNearExpiry: false })),
}));

await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['qwen3-max', 'glm-4.6', 'deepseek-r1']),
}));

let IFlowTokenStorage;
let isThinkingModel;
let applyIFlowThinkingConfig;
let preserveReasoningContentInMessages;
let ensureToolsArray;
let preprocessRequestBody;
let loadTokenFromFile;
let iflowMod;
let IFlowApiService;

beforeAll(async () => {
    iflowMod = await import('../../../src/providers/openai/iflow-core.js');
    IFlowTokenStorage = iflowMod.IFlowTokenStorage;
    isThinkingModel = iflowMod.isThinkingModel;
    applyIFlowThinkingConfig = iflowMod.applyIFlowThinkingConfig;
    preserveReasoningContentInMessages = iflowMod.preserveReasoningContentInMessages;
    ensureToolsArray = iflowMod.ensureToolsArray;
    preprocessRequestBody = iflowMod.preprocessRequestBody;
    loadTokenFromFile = iflowMod.loadTokenFromFile;
    IFlowApiService = iflowMod.IFlowApiService;
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('IFlowTokenStorage', () => {
    test('fromJSON maps alternate field names', () => {
        const t = IFlowTokenStorage.fromJSON({
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: '123',
            api_key: 'k',
        });
        expect(t.accessToken).toBe('a');
        expect(t.refreshToken).toBe('r');
        expect(t.apiKey).toBe('k');
        const json = t.toJSON();
        expect(json.access_token).toBe('a');
        expect(json.apiKey).toBe('k');
    });
});

describe('isThinkingModel', () => {
    test('returns true for glm / qwen thinking / deepseek-r1 prefixes', () => {
        expect(isThinkingModel('glm-4.6')).toBe(true);
        expect(isThinkingModel('qwen3-235b-a22b-thinking')).toBe(true);
        expect(isThinkingModel('deepseek-r1')).toBe(true);
    });

    test('returns false for empty or non-thinking models', () => {
        expect(isThinkingModel('')).toBe(false);
        expect(isThinkingModel(null)).toBe(false);
        expect(isThinkingModel('gpt-4')).toBe(false);
    });
});

describe('applyIFlowThinkingConfig', () => {
    test('returns body unchanged when no reasoning_effort', () => {
        const body = { model: 'x', messages: [] };
        expect(applyIFlowThinkingConfig(body, 'glm-4.6')).toBe(body);
    });

    test('GLM-4: maps reasoning_effort to chat_template_kwargs', () => {
        const out = applyIFlowThinkingConfig(
            { reasoning_effort: 'high', messages: [] },
            'glm-4.6',
        );
        expect(out.reasoning_effort).toBeUndefined();
        expect(out.chat_template_kwargs?.enable_thinking).toBe(true);
    });

    test('removes reasoning_effort for deepseek-r1 without glm branch', () => {
        const out = applyIFlowThinkingConfig({ reasoning_effort: 'none' }, 'deepseek-r1');
        expect(out.reasoning_effort).toBeUndefined();
    });
});

describe('preserveReasoningContentInMessages', () => {
    test('returns body unchanged for non-glm/minimax models', () => {
        const b = { messages: [{ role: 'assistant', reasoning_content: 'x' }] };
        expect(preserveReasoningContentInMessages(b, 'qwen3-max')).toBe(b);
    });

    test('passes through glm-4 with reasoning in history', () => {
        const b = {
            messages: [{ role: 'assistant', reasoning_content: 'rc' }],
        };
        const out = preserveReasoningContentInMessages(b, 'glm-4.6');
        expect(out.messages[0].reasoning_content).toBe('rc');
    });
});

describe('ensureToolsArray', () => {
    test('returns body when tools missing', () => {
        expect(ensureToolsArray({ model: 'x' })).toEqual({ model: 'x' });
    });

    test('replaces empty tools with placeholder', () => {
        const out = ensureToolsArray({ tools: [] });
        expect(out.tools).toHaveLength(1);
        expect(out.tools[0].function.name).toBe('noop');
    });
});

describe('preprocessRequestBody', () => {
    test('normalizes unknown model to first IFLOW model and applies pipeline', () => {
        const out = preprocessRequestBody({ model: 'unknown-model-xyz', messages: [] }, 'unknown-model-xyz');
        expect(out.model).toBe('qwen3-max');
    });
});

describe('loadTokenFromFile / saveTokenToFile', () => {
    let dir;
    let tokenPath;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'iflow-test-'));
        tokenPath = join(dir, 'oauth_creds.json');
    });

    test('loadTokenFromFile reads valid JSON', async () => {
        writeFileSync(
            tokenPath,
            JSON.stringify({ apiKey: 'sk-test', refresh_token: 'rt' }),
            'utf-8',
        );
        const t = await loadTokenFromFile(tokenPath);
        expect(t.apiKey).toBe('sk-test');
        rmSync(dir, { recursive: true, force: true });
    });

    test('loadTokenFromFile returns null on ENOENT', async () => {
        const t = await loadTokenFromFile(join(dir, 'missing.json'));
        expect(t).toBeNull();
        rmSync(dir, { recursive: true, force: true });
    });

    test('saveTokenToFile writes IFlowTokenStorage', async () => {
        const ts = new IFlowTokenStorage({ apiKey: 'k', refreshToken: 'r' });
        await iflowMod.saveTokenToFile(tokenPath, ts);
        const raw = await import('fs').then((fs) => fs.promises.readFile(tokenPath, 'utf-8'));
        const parsed = JSON.parse(raw);
        expect(parsed.apiKey).toBe('k');
        expect(parsed.refresh_token).toBe('r');
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('IFlowApiService', () => {
    test('constructor sets baseUrl and creates axios via axios.create', async () => {
        const axios = (await import('axios')).default;
        const svc = new IFlowApiService({
            IFLOW_BASE_URL: 'https://apis.iflow.cn/v1',
            uuid: 'u1',
        });
        expect(svc.baseUrl).toBe('https://apis.iflow.cn/v1');
        expect(axios.create).toHaveBeenCalled();
    });

    test('initialize sets isInitialized and calls loadCredentials', async () => {
        const svc = new IFlowApiService({
            IFLOW_TOKEN_FILE_PATH: join(tmpdir(), 'nonexistent-iflow-' + Date.now()),
            uuid: 'u1',
        });
        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
    });

    test('initialize is idempotent', async () => {
        const svc = new IFlowApiService({
            IFLOW_TOKEN_FILE_PATH: join(tmpdir(), 'nonexistent-iflow-' + Date.now()),
            uuid: 'u1',
        });
        await svc.initialize();
        const spy = jest.spyOn(svc, 'loadCredentials');
        await svc.initialize();
        expect(spy).not.toHaveBeenCalled();
    });

    test('isExpiryDateNear returns false when no tokenStorage', () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('isExpiryDateNear works with numeric timestamp (expired)', () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.tokenStorage = new IFlowTokenStorage({ expiryDate: Date.now() - 1000 }); // already expired
        const result = svc.isExpiryDateNear();
        expect(typeof result).toBe('boolean');
    });

    test('isExpiryDateNear works with numeric string timestamp', () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.tokenStorage = new IFlowTokenStorage({ expiryDate: String(Date.now() + 99999999) });
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('isExpiryDateNear works with ISO 8601 date', () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.tokenStorage = new IFlowTokenStorage({ expiryDate: new Date(Date.now() + 99999999).toISOString() });
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('_maskToken masks mid-characters', () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        expect(svc._maskToken('abcdefghijklmn')).toMatch(/^abcd\.\.\.klmn$/);
        expect(svc._maskToken('short')).toBe('***');
        expect(svc._maskToken(null)).toBe('***');
    });

    test('_getHeaders returns required headers', () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.apiKey = 'test-key-123';
        const headers = svc._getHeaders(false);
        expect(headers['Authorization']).toBe('Bearer test-key-123');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['session-id']).toBeDefined();
        expect(headers['x-iflow-timestamp']).toBeDefined();
        expect(headers['Accept']).toBe('application/json');
    });

    test('_getHeaders sets Accept to text/event-stream for stream=true', () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.apiKey = 'test-key-123';
        const headers = svc._getHeaders(true);
        expect(headers['Accept']).toBe('text/event-stream');
    });
});

describe('IFlowApiService — callApi', () => {
    function makeService() {
        const svc = new IFlowApiService({
            uuid: 'u1',
            REQUEST_MAX_RETRIES: 0,
        });
        svc.isInitialized = true;
        svc.apiKey = 'sk-iflow';
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn() };
        return svc;
    }

    test('returns data on success', async () => {
        const svc = makeService();
        svc.axiosInstance.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } });
        const result = await svc.callApi('/chat/completions', { messages: [] }, 'qwen3-max');
        expect(result.choices[0].message.content).toBe('ok');
    });

    test('throws 401 error and marks pool', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        const mockPool = { markProviderNeedRefresh: jest.fn(), resetProviderRefreshStatus: jest.fn() };
        getProviderPoolManager.mockReturnValue(mockPool);

        const svc = makeService();
        const err = Object.assign(new Error('unauth'), { response: { status: 401, data: {} } });
        svc.axiosInstance.post.mockRejectedValueOnce(err);
        await expect(svc.callApi('/chat/completions', {}, 'qwen3-max')).rejects.toBe(err);
        expect(mockPool.markProviderNeedRefresh).toHaveBeenCalled();
        getProviderPoolManager.mockReturnValue(null); // reset so subsequent tests are not affected
    });

    test('retries on 429 and succeeds', async () => {
        const svc = new IFlowApiService({ uuid: 'u1', REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        svc.isInitialized = true;
        svc.apiKey = 'sk-iflow';
        const mockPost = jest.fn();
        svc.axiosInstance = { defaults: { headers: {} }, post: mockPost, get: jest.fn() };

        const err429 = Object.assign(new Error('rate'), { response: { status: 429, data: {} } });
        mockPost
            .mockRejectedValueOnce(err429)
            .mockResolvedValueOnce({ data: { retried: true } });

        const result = await svc.callApi('/chat/completions', {}, 'qwen3-max');
        expect(result).toEqual({ retried: true });
        expect(mockPost).toHaveBeenCalledTimes(2);
    });

    test('retries on 500 and succeeds', async () => {
        const svc = new IFlowApiService({ uuid: 'u1', REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        svc.isInitialized = true;
        svc.apiKey = 'sk-iflow';
        const mockPost = jest.fn();
        svc.axiosInstance = { defaults: { headers: {} }, post: mockPost, get: jest.fn() };

        const err500 = Object.assign(new Error('server'), { response: { status: 500, data: {} } });
        mockPost
            .mockRejectedValueOnce(err500)
            .mockResolvedValueOnce({ data: { ok: true } });

        const result = await svc.callApi('/chat/completions', {}, 'qwen3-max');
        expect(result).toEqual({ ok: true });
    });
});

describe('IFlowApiService — streamApi', () => {
    function makeService() {
        const svc = new IFlowApiService({ uuid: 'u1', REQUEST_MAX_RETRIES: 0 });
        svc.isInitialized = true;
        svc.apiKey = 'sk-iflow';
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn() };
        return svc;
    }

    test('yields parsed SSE chunks from stream', async () => {
        const svc = makeService();
        const chunk = { choices: [{ delta: { content: 'hello' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

        async function* makeStream() { yield Buffer.from(sseData); }
        svc.axiosInstance.post.mockResolvedValueOnce({ data: makeStream() });

        const results = [];
        for await (const c of svc.streamApi('/chat/completions', { messages: [] }, 'qwen3-max')) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(chunk);
    });

    test('throws 401 error without retry', async () => {
        const svc = makeService();
        const err = Object.assign(new Error('unauth'), { response: { status: 401, data: {} } });
        svc.axiosInstance.post.mockRejectedValueOnce(err);
        await expect(async () => {
            for await (const _ of svc.streamApi('/chat/completions', {}, 'qwen3-max')) { /* drain */ }
        }).rejects.toBe(err);
    });

    test('retries on 429 and yields chunks', async () => {
        const svc = new IFlowApiService({ uuid: 'u1', REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        svc.isInitialized = true;
        svc.apiKey = 'sk-iflow';
        const mockPost = jest.fn();
        svc.axiosInstance = { defaults: { headers: {} }, post: mockPost, get: jest.fn() };

        const err429 = Object.assign(new Error('rate'), { response: { status: 429, data: {} } });
        const chunk = { choices: [{ delta: { content: 'retried' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
        async function* makeStream() { yield Buffer.from(sseData); }

        mockPost
            .mockRejectedValueOnce(err429)
            .mockResolvedValueOnce({ data: makeStream() });

        const results = [];
        for await (const c of svc.streamApi('/chat/completions', {}, 'qwen3-max')) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
        expect(mockPost).toHaveBeenCalledTimes(2);
    });
});

describe('IFlowApiService — generateContent', () => {
    function makeService() {
        const svc = new IFlowApiService({ uuid: 'u1', REQUEST_MAX_RETRIES: 0 });
        svc.isInitialized = true;
        svc.apiKey = 'sk-iflow';
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn() };
        return svc;
    }

    test('returns API response', async () => {
        const svc = makeService();
        const payload = { id: 'cmpl-1', choices: [{ message: { content: 'Hi' } }] };
        svc.axiosInstance.post.mockResolvedValueOnce({ data: payload });
        const result = await svc.generateContent('qwen3-max', { messages: [{ role: 'user', content: 'Hello' }] });
        expect(result.id).toBe('cmpl-1');
    });

    test('strips _monitorRequestId and _requestBaseUrl', async () => {
        const svc = makeService();
        svc.axiosInstance.post.mockResolvedValueOnce({ data: {} });
        const body = { messages: [], _monitorRequestId: 'req-1', _requestBaseUrl: 'http://x.com' };
        await svc.generateContent('qwen3-max', body);
        expect(body._monitorRequestId).toBeUndefined();
        expect(body._requestBaseUrl).toBeUndefined();
        expect(svc.config._monitorRequestId).toBe('req-1');
    });
});

describe('IFlowApiService — generateContentStream', () => {
    function makeService() {
        const svc = new IFlowApiService({ uuid: 'u1', REQUEST_MAX_RETRIES: 0 });
        svc.isInitialized = true;
        svc.apiKey = 'sk-iflow';
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn() };
        return svc;
    }

    test('yields chunks from streamApi', async () => {
        const svc = makeService();
        const chunk = { choices: [{ delta: { content: 'stream' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
        async function* makeStream() { yield Buffer.from(sseData); }
        svc.axiosInstance.post.mockResolvedValueOnce({ data: makeStream() });

        const results = [];
        for await (const c of svc.generateContentStream('qwen3-max', { messages: [] })) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
    });

    test('strips _monitorRequestId before streaming', async () => {
        const svc = makeService();
        async function* emptyStream() {}
        svc.axiosInstance.post.mockResolvedValueOnce({ data: emptyStream() });

        const body = { messages: [], _monitorRequestId: 'stream-123', _requestBaseUrl: 'http://y.com' };
        for await (const _ of svc.generateContentStream('qwen3-max', body)) { /* drain */ }
        expect(body._monitorRequestId).toBeUndefined();
        expect(body._requestBaseUrl).toBeUndefined();
    });
});

describe('IFlowApiService — listModels', () => {
    function makeService() {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.isInitialized = true;
        svc.apiKey = 'sk-iflow';
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn() };
        return svc;
    }

    test('returns model list from API and appends missing models', async () => {
        const svc = makeService();
        svc.axiosInstance.get.mockResolvedValueOnce({
            data: { object: 'list', data: [{ id: 'qwen3-max' }] },
        });
        const result = await svc.listModels();
        expect(result.data.length).toBeGreaterThan(1);
        expect(result.data.some(m => m.id === 'glm-4.7')).toBe(true);
    });

    test('falls back to static list on error', async () => {
        const svc = makeService();
        svc.axiosInstance.get.mockRejectedValueOnce(new Error('Network error'));
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
    });
});

describe('IFlowApiService — refreshToken', () => {
    test('returns false when _refreshOAuthTokens fails', async () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.isInitialized = true;
        svc.tokenStorage = new IFlowTokenStorage({ refreshToken: 'rt', apiKey: 'k' });
        svc._refreshOAuthTokens = jest.fn().mockRejectedValue(new Error('refresh failed'));
        const result = await svc.refreshToken();
        expect(result).toBe(false);
    });

    test('returns true when _refreshOAuthTokens succeeds', async () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.isInitialized = true;
        svc.tokenStorage = new IFlowTokenStorage({ refreshToken: 'rt', apiKey: 'k' });
        svc._refreshOAuthTokens = jest.fn().mockResolvedValue(undefined);
        const result = await svc.refreshToken();
        expect(result).toBe(true);
    });
});

describe('saveTokenToFile — error path', () => {
    test('throws when write fails (bad path)', async () => {
        // Use a path whose parent cannot be created (e.g. file as directory)
        const ts = new IFlowTokenStorage({ apiKey: 'k', refreshToken: 'r' });
        // Provide a path that cannot be written to
        await expect(
            iflowMod.saveTokenToFile('/proc/nonexistent-dir/no-write/token.json', ts),
        ).rejects.toThrow('[iFlow] Failed to save token to file');
    });
});

describe('IFlowApiService — _refreshOAuthTokens (direct)', () => {
    let dir;
    let tokenPath;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'iflow-refresh-'));
        tokenPath = join(dir, 'token.json');
    });

    function makeService(path) {
        const svc = new IFlowApiService({ uuid: 'u1', IFLOW_TOKEN_FILE_PATH: path });
        svc.isInitialized = true;
        svc.tokenFilePath = path;
        return svc;
    }

    test('throws when no refreshToken in tokenStorage', async () => {
        const svc = makeService(tokenPath);
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: jest.fn() };
        svc.tokenStorage = new IFlowTokenStorage({ apiKey: 'k' }); // no refreshToken
        await expect(svc._refreshOAuthTokens()).rejects.toThrow('[iFlow] No refresh_token available');
    });

    test('throws when no tokenStorage', async () => {
        const svc = makeService(tokenPath);
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: jest.fn() };
        svc.tokenStorage = null;
        await expect(svc._refreshOAuthTokens()).rejects.toThrow('[iFlow] No refresh_token available');
    });

    test('successful refresh: updates tokenStorage and apiKey', async () => {
        const svc = makeService(tokenPath);
        const mockRequest = jest.fn();
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: mockRequest };
        svc.tokenStorage = new IFlowTokenStorage({
            refreshToken: 'rt-old',
            accessToken: 'old-at',
            apiKey: 'old-key',
        });

        // First request: token refresh endpoint
        mockRequest.mockResolvedValueOnce({
            data: {
                access_token: 'new-at',
                refresh_token: 'new-rt',
                expires_in: 3600,
                token_type: 'Bearer',
            },
        });
        // Second request: fetchUserInfo endpoint
        mockRequest.mockResolvedValueOnce({
            data: {
                success: true,
                data: { apiKey: 'new-api-key', email: 'user@example.com' },
            },
        });

        await svc._refreshOAuthTokens();
        expect(svc.tokenStorage.accessToken).toBe('new-at');
        expect(svc.tokenStorage.refreshToken).toBe('new-rt');
        expect(svc.apiKey).toBe('new-api-key');
        rmSync(dir, { recursive: true, force: true });
    });

    test('throws when token refresh request returns no access_token', async () => {
        const svc = makeService(tokenPath);
        const mockRequest = jest.fn();
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: mockRequest };
        svc.tokenStorage = new IFlowTokenStorage({ refreshToken: 'rt-old', apiKey: 'k' });

        // Returns response without access_token
        mockRequest.mockResolvedValueOnce({ data: { token_type: 'Bearer' } });

        await expect(svc._refreshOAuthTokens()).rejects.toThrow();
        rmSync(dir, { recursive: true, force: true });
    });

    test('throws when token refresh request fails', async () => {
        const svc = makeService(tokenPath);
        const mockRequest = jest.fn();
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: mockRequest };
        svc.tokenStorage = new IFlowTokenStorage({ refreshToken: 'rt-old', apiKey: 'k' });

        mockRequest.mockRejectedValueOnce(Object.assign(new Error('Network error'), { response: { status: 503, data: 'Service Unavailable' } }));

        await expect(svc._refreshOAuthTokens()).rejects.toThrow('Network error');
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('IFlowApiService — _checkAndRefreshTokenIfNeeded', () => {
    test('returns false when no tokenStorage', async () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.isInitialized = true;
        svc.tokenStorage = null;
        const result = await svc._checkAndRefreshTokenIfNeeded();
        expect(result).toBe(false);
    });

    test('returns false when no refreshToken', async () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.isInitialized = true;
        svc.tokenStorage = new IFlowTokenStorage({ apiKey: 'k' }); // no refreshToken
        const result = await svc._checkAndRefreshTokenIfNeeded();
        expect(result).toBe(false);
    });

    test('returns true when refresh succeeds', async () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.isInitialized = true;
        svc.tokenStorage = new IFlowTokenStorage({ refreshToken: 'rt', apiKey: 'k' });
        svc._refreshOAuthTokens = jest.fn().mockResolvedValue(undefined);
        const result = await svc._checkAndRefreshTokenIfNeeded();
        expect(result).toBe(true);
        expect(svc._refreshOAuthTokens).toHaveBeenCalledTimes(1);
    });

    test('returns false when refresh throws', async () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.isInitialized = true;
        svc.tokenStorage = new IFlowTokenStorage({ refreshToken: 'rt', apiKey: 'k' });
        svc._refreshOAuthTokens = jest.fn().mockRejectedValue(new Error('refresh failed'));
        const result = await svc._checkAndRefreshTokenIfNeeded();
        expect(result).toBe(false);
    });
});

describe('IFlowApiService — initializeAuth', () => {
    let dir;
    let tokenPath;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'iflow-auth-'));
        tokenPath = join(dir, 'token.json');
    });

    test('returns early when apiKey exists and forceRefresh=false', async () => {
        writeFileSync(tokenPath, JSON.stringify({ apiKey: 'sk-existing', refresh_token: 'rt', access_token: 'at' }), 'utf-8');
        const svc = new IFlowApiService({ uuid: 'u1', IFLOW_TOKEN_FILE_PATH: tokenPath });
        svc.isInitialized = true;
        svc.tokenFilePath = tokenPath;
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: jest.fn() };
        await svc.initializeAuth(false);
        expect(svc.apiKey).toBe('sk-existing');
        rmSync(dir, { recursive: true, force: true });
    });

    test('calls _refreshOAuthTokens when forceRefresh=true', async () => {
        writeFileSync(tokenPath, JSON.stringify({ apiKey: 'sk-existing', refresh_token: 'rt', access_token: 'at' }), 'utf-8');
        // Ensure getProviderPoolManager returns a complete mock (not stale from previous tests)
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        getProviderPoolManager.mockReturnValue({ resetProviderRefreshStatus: jest.fn() });

        const spy = jest.spyOn(IFlowApiService.prototype, '_refreshOAuthTokens').mockResolvedValue(undefined);

        const svc = new IFlowApiService({ uuid: 'u1', IFLOW_TOKEN_FILE_PATH: tokenPath });
        svc.isInitialized = true;
        svc.tokenFilePath = tokenPath;
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: jest.fn() };

        await svc.initializeAuth(true);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
        getProviderPoolManager.mockReturnValue(null);
        rmSync(dir, { recursive: true, force: true });
    });

    test('throws when no IFLOW_TOKEN_FILE_PATH and no apiKey', async () => {
        const svc = new IFlowApiService({ uuid: 'u1' });
        svc.isInitialized = true;
        svc.tokenFilePath = null;
        svc.apiKey = null;
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: jest.fn() };
        // This throws before reaching the try/catch block
        await expect(svc.initializeAuth(false)).rejects.toThrow('[iFlow] IFLOW_TOKEN_FILE_PATH is required.');
        rmSync(dir, { recursive: true, force: true });
    });

    test('throws when tokenStorage has no apiKey', async () => {
        writeFileSync(tokenPath, JSON.stringify({ refresh_token: 'rt' }), 'utf-8'); // no apiKey
        const svc = new IFlowApiService({ uuid: 'u1', IFLOW_TOKEN_FILE_PATH: tokenPath });
        svc.isInitialized = true;
        svc.tokenFilePath = tokenPath;
        svc.apiKey = null;
        svc.axiosInstance = { defaults: { headers: {} }, post: jest.fn(), get: jest.fn(), request: jest.fn() };
        await expect(svc.initializeAuth(false)).rejects.toThrow('[iFlow Auth] Failed to load OAuth credentials.');
        rmSync(dir, { recursive: true, force: true });
    });
});
