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
});
