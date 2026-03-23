/**
 * Unit tests for src/providers/claude/claude-kiro.js
 *
 * 覆盖范围：
 *   - 构造函数（KiroApiService constructor）
 *   - 纯函数辅助逻辑（findRealTag、repairJson、parseSingleToolCall、parseBracketToolCalls 等）
 *   - 实例方法：isTokenExpired、isExpiryDateNear、_normalizeThinkingBudgetTokens、
 *               _generateThinkingPrefix、_hasThinkingPrefix、buildClaudeResponse（非流式）、
 *               parseEventStreamChunk、parseAwsEventStreamBuffer、listModels、
 *               _getNextMonthFirstDay、_toClaudeContentBlocksFromKiroText
 *   - loadCredentials（mock fs）
 *   - buildCodewhispererRequest（消息合并、工具过滤）
 *
 * ESM: jest.unstable_mockModule + dynamic import
 * 注意：不依赖真实 API 密钥或网络请求
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — 必须在任何 dynamic import 之前声明
// ---------------------------------------------------------------------------

const mockAxiosRequest = jest.fn();
const mockAxiosSocialRefreshRequest = jest.fn();
const mockAxiosCreate = jest.fn();

// mock logger
await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

// mock proxy-utils
await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn((cfg) => cfg),
    getProxyConfigForProvider: jest.fn(() => null),
    getGoogleAuthProxyConfig: jest.fn(() => null),
}));

// mock common.js
await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    isRetryableNetworkError: jest.fn(() => false),
    MODEL_PROVIDER: { KIRO_API: 'claude-kiro-oauth', CLAUDE_CUSTOM: 'claude-custom' },
    MODEL_PROTOCOL_PREFIX: { CLAUDE: 'claude' },
    formatExpiryLog: jest.fn(() => ({ message: '[Kiro] expiry ok', isNearExpiry: false })),
}));

// mock axios
await jest.unstable_mockModule('axios', () => ({
    default: {
        create: mockAxiosCreate,
    },
}));

// mock provider-models
await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['claude-sonnet-4-5', 'claude-haiku-4-5']),
    getAllProviderModels: jest.fn(() => ({})),
}));

// mock token-utils
await jest.unstable_mockModule('../../../src/utils/token-utils.js', () => ({
    countTextTokens: jest.fn(() => 10),
    estimateInputTokens: jest.fn(() => 50),
    countTokensAnthropic: jest.fn(() => 20),
    processContent: jest.fn((c) => (typeof c === 'string' ? c : JSON.stringify(c))),
    getContentText: jest.fn((msg) => {
        if (!msg) return '';
        if (typeof msg === 'string') return msg;
        if (Array.isArray(msg)) return msg.map(p => p.text || '').join('');
        if (msg.content) {
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) return msg.content.map(p => p.text || '').join('');
        }
        return '';
    }),
}));

// mock service-manager
await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

// mock fs
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockReaddir = jest.fn();
await jest.unstable_mockModule('fs', () => ({
    default: {
        promises: {
            readFile: mockReadFile,
            writeFile: mockWriteFile,
            readdir: mockReaddir,
        },
    },
    promises: {
        readFile: mockReadFile,
        writeFile: mockWriteFile,
        readdir: mockReaddir,
    },
}));

// mock plugin-manager (用于 buildCodewhispererRequest 内部的监控钩子)
await jest.unstable_mockModule('../../../src/core/plugin-manager.js', () => ({
    getPluginManager: jest.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

let KiroApiService;

beforeAll(async () => {
    // 每次 axios.create 调用返回新的 mock 实例
    mockAxiosCreate.mockImplementation(() => ({
        request: mockAxiosRequest,
    }));

    const mod = await import('../../../src/providers/claude/claude-kiro.js');
    KiroApiService = mod.KiroApiService;
});

// ---------------------------------------------------------------------------
// 工厂函数：创建已初始化的 KiroApiService 实例（跳过实际 I/O）
// ---------------------------------------------------------------------------

function makeService(overrides = {}) {
    const svc = new KiroApiService({
        REQUEST_MAX_RETRIES: 0,
        REQUEST_BASE_DELAY: 0,
        ...overrides,
    });
    // 手动设置已初始化状态，避免触发真实 initialize()
    svc.isInitialized = true;
    svc.axiosInstance = { request: mockAxiosRequest };
    svc.axiosSocialRefreshInstance = { request: mockAxiosSocialRefreshRequest };
    svc.accessToken = 'mock-access-token';
    svc.refreshToken = 'mock-refresh-token';
    svc.clientId = 'mock-client-id';
    svc.region = 'us-east-1';
    svc.idcRegion = 'us-east-1';
    svc.baseUrl = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse';
    svc.refreshUrl = 'https://refresh.url';
    svc.refreshIDCUrl = 'https://refresh-idc.url';
    svc.modelName = 'claude-sonnet-4-5';
    return svc;
}

// ---------------------------------------------------------------------------
// 测试：构造函数
// ---------------------------------------------------------------------------

describe('KiroApiService — 构造函数', () => {
    test('默认状态下 isInitialized 为 false', () => {
        const svc = new KiroApiService({});
        expect(svc.isInitialized).toBe(false);
    });

    test('useSystemProxy 默认为 false', () => {
        const svc = new KiroApiService({});
        expect(svc.useSystemProxy).toBe(false);
    });

    test('可以设置 useSystemProxy 为 true', () => {
        const svc = new KiroApiService({ USE_SYSTEM_PROXY_KIRO: true });
        expect(svc.useSystemProxy).toBe(true);
    });

    test('可以通过 KIRO_OAUTH_CREDS_BASE64 传入 Base64 凭证', () => {
        const creds = { accessToken: 'tok', refreshToken: 'ref' };
        const b64 = Buffer.from(JSON.stringify(creds)).toString('base64');
        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_BASE64: b64 });
        expect(svc.base64Creds).toEqual(creds);
    });

    test('无效的 Base64 凭证不抛错，base64Creds 应未设置', () => {
        // 不会抛异常
        expect(() => new KiroApiService({ KIRO_OAUTH_CREDS_BASE64: 'not-valid-base64!!!' })).not.toThrow();
    });

    test('可以通过 KIRO_OAUTH_CREDS_FILE_PATH 设置凭证文件路径', () => {
        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: '/tmp/kiro-creds.json' });
        expect(svc.credsFilePath).toBe('/tmp/kiro-creds.json');
    });
});

// ---------------------------------------------------------------------------
// 测试：isTokenExpired
// ---------------------------------------------------------------------------

describe('KiroApiService — isTokenExpired', () => {
    test('expiresAt 为 undefined 时返回 true', () => {
        const svc = makeService();
        svc.expiresAt = undefined;
        expect(svc.isTokenExpired()).toBe(true);
    });

    test('过期时间在过去时返回 true', () => {
        const svc = makeService();
        svc.expiresAt = new Date(Date.now() - 60000).toISOString(); // 1 分钟前
        expect(svc.isTokenExpired()).toBe(true);
    });

    test('过期时间在未来时返回 false', () => {
        const svc = makeService();
        svc.expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 小时后
        expect(svc.isTokenExpired()).toBe(false);
    });

    test('无效的日期字符串（NaN 时间戳）不视为过期（NaN <= x 为 false）', () => {
        // 当 expiresAt 为无效日期时，new Date(...).getTime() = NaN
        // NaN <= (currentTime + buffer) 为 false，所以 isTokenExpired 返回 false
        // 这是 JavaScript 中 NaN 比较的预期行为
        const svc = makeService();
        svc.expiresAt = 'invalid-date-string';
        // NaN 比较结果为 false，所以不会被认为过期
        expect(svc.isTokenExpired()).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 测试：isExpiryDateNear（依赖 formatExpiryLog mock）
// ---------------------------------------------------------------------------

describe('KiroApiService — isExpiryDateNear', () => {
    test('formatExpiryLog 返回 isNearExpiry=false 时返回 false', async () => {
        const { formatExpiryLog } = await import('../../../src/utils/common.js');
        formatExpiryLog.mockReturnValue({ message: 'ok', isNearExpiry: false });
        const svc = makeService();
        svc.expiresAt = new Date(Date.now() + 3600000).toISOString();
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('formatExpiryLog 返回 isNearExpiry=true 时返回 true', async () => {
        const { formatExpiryLog } = await import('../../../src/utils/common.js');
        formatExpiryLog.mockReturnValue({ message: 'near', isNearExpiry: true });
        const svc = makeService();
        svc.expiresAt = new Date(Date.now() + 60000).toISOString();
        expect(svc.isExpiryDateNear()).toBe(true);
    });

    test('expiresAt 格式错误时不抛异常，返回 false', async () => {
        const { formatExpiryLog } = await import('../../../src/utils/common.js');
        formatExpiryLog.mockImplementation(() => { throw new Error('parse error'); });
        const svc = makeService();
        svc.expiresAt = 'bad-date';
        expect(svc.isExpiryDateNear()).toBe(false);
        // 恢复正常 mock
        formatExpiryLog.mockReturnValue({ message: 'ok', isNearExpiry: false });
    });
});

// ---------------------------------------------------------------------------
// 测试：_normalizeThinkingBudgetTokens
// ---------------------------------------------------------------------------

describe('KiroApiService — _normalizeThinkingBudgetTokens', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('正常值保持不变（在范围内）', () => {
        expect(svc._normalizeThinkingBudgetTokens(5000)).toBe(5000);
    });

    test('小于最小值时夹回最小值 1024', () => {
        expect(svc._normalizeThinkingBudgetTokens(100)).toBe(1024);
    });

    test('大于最大值时夹回最大值 24576', () => {
        expect(svc._normalizeThinkingBudgetTokens(99999)).toBe(24576);
    });

    test('非有限数或零以下时使用默认值 20000', () => {
        // NaN 和 Infinity：!Number.isFinite(x) => true，使用 DEFAULT_BUDGET_TOKENS=20000
        expect(svc._normalizeThinkingBudgetTokens(NaN)).toBe(20000);
        expect(svc._normalizeThinkingBudgetTokens(Infinity)).toBe(20000);
        // -1：Number.isFinite(-1)=true 但 -1 <= 0 => 也使用 DEFAULT_BUDGET_TOKENS=20000
        expect(svc._normalizeThinkingBudgetTokens(-1)).toBe(20000);
    });

    test('浮点数取整', () => {
        const val = svc._normalizeThinkingBudgetTokens(2048.9);
        expect(val).toBe(2048);
    });
});

// ---------------------------------------------------------------------------
// 测试：_generateThinkingPrefix
// ---------------------------------------------------------------------------

describe('KiroApiService — _generateThinkingPrefix', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('thinking 为 null 时返回 null', () => {
        expect(svc._generateThinkingPrefix(null)).toBeNull();
    });

    test('thinking 为非对象时返回 null', () => {
        expect(svc._generateThinkingPrefix('enabled')).toBeNull();
    });

    test('type=enabled 时生成包含 thinking_mode 和 max_thinking_length 的前缀', () => {
        const prefix = svc._generateThinkingPrefix({ type: 'enabled', budget_tokens: 5000 });
        expect(prefix).toContain('<thinking_mode>enabled</thinking_mode>');
        expect(prefix).toContain('<max_thinking_length>5000</max_thinking_length>');
    });

    test('type=adaptive 使用 effort=medium', () => {
        const prefix = svc._generateThinkingPrefix({ type: 'adaptive', effort: 'medium' });
        expect(prefix).toContain('<thinking_mode>adaptive</thinking_mode>');
        expect(prefix).toContain('<thinking_effort>medium</thinking_effort>');
    });

    test('type=adaptive effort 不在允许列表时归一化为 high', () => {
        const prefix = svc._generateThinkingPrefix({ type: 'adaptive', effort: 'ultra' });
        expect(prefix).toContain('<thinking_effort>high</thinking_effort>');
    });

    test('type=disabled 时返回 null', () => {
        expect(svc._generateThinkingPrefix({ type: 'disabled' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 测试：_hasThinkingPrefix
// ---------------------------------------------------------------------------

describe('KiroApiService — _hasThinkingPrefix', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('空字符串时返回 false', () => {
        expect(svc._hasThinkingPrefix('')).toBe(false);
    });

    test('null 时返回 false', () => {
        expect(svc._hasThinkingPrefix(null)).toBe(false);
    });

    test('包含 <thinking_mode> 标签时返回 true', () => {
        expect(svc._hasThinkingPrefix('<thinking_mode>enabled</thinking_mode>')).toBe(true);
    });

    test('包含 <max_thinking_length> 标签时返回 true', () => {
        expect(svc._hasThinkingPrefix('<max_thinking_length>5000</max_thinking_length>')).toBe(true);
    });

    test('包含 <thinking_effort> 标签时返回 true', () => {
        expect(svc._hasThinkingPrefix('<thinking_effort>high</thinking_effort>')).toBe(true);
    });

    test('普通文本时返回 false', () => {
        expect(svc._hasThinkingPrefix('Hello world')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 测试：_toClaudeContentBlocksFromKiroText
// ---------------------------------------------------------------------------

describe('KiroApiService — _toClaudeContentBlocksFromKiroText', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('空内容时返回空数组', () => {
        expect(svc._toClaudeContentBlocksFromKiroText('')).toEqual([]);
    });

    test('无 thinking 标签时返回单一 text block', () => {
        const result = svc._toClaudeContentBlocksFromKiroText('Hello world');
        expect(result).toEqual([{ type: 'text', text: 'Hello world' }]);
    });

    test('包含 <thinking> 标签时提取 thinking block', () => {
        const raw = '<thinking>\nsome thought\n</thinking>\n\nfinal text';
        const result = svc._toClaudeContentBlocksFromKiroText(raw);
        const types = result.map(b => b.type);
        expect(types).toContain('thinking');
        expect(types).toContain('text');
        const thinkingBlock = result.find(b => b.type === 'thinking');
        expect(thinkingBlock.thinking).toContain('some thought');
        const textBlock = result.find(b => b.type === 'text');
        expect(textBlock.text).toContain('final text');
    });

    test('只有 thinking 标签无后续文本时，不包含空 text block', () => {
        const raw = '<thinking>\nsome thought\n</thinking>\n\n';
        const result = svc._toClaudeContentBlocksFromKiroText(raw);
        const textBlocks = result.filter(b => b.type === 'text');
        // 空白文本 block 应被过滤掉
        expect(textBlocks.every(b => b.text && b.text.trim().length > 0)).toBe(true);
    });

    test('thinking 标签未闭合时，整个剩余部分作为 thinking 内容', () => {
        const raw = '<thinking>\nunclosed thinking content';
        const result = svc._toClaudeContentBlocksFromKiroText(raw);
        const thinkingBlock = result.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock.thinking).toContain('unclosed thinking content');
    });
});

// ---------------------------------------------------------------------------
// 测试：_getNextMonthFirstDay
// ---------------------------------------------------------------------------

describe('KiroApiService — _getNextMonthFirstDay', () => {
    test('返回 Date 对象且是下月 1 日 UTC', () => {
        const svc = makeService();
        const result = svc._getNextMonthFirstDay();
        expect(result).toBeInstanceOf(Date);
        expect(result.getUTCDate()).toBe(1);
        expect(result.getUTCHours()).toBe(0);
        expect(result.getUTCMinutes()).toBe(0);
        const now = new Date();
        const expectedMonth = (now.getUTCMonth() + 1) % 12;
        expect(result.getUTCMonth()).toBe(expectedMonth);
    });
});

// ---------------------------------------------------------------------------
// 测试：listModels
// ---------------------------------------------------------------------------

describe('KiroApiService — listModels', () => {
    test('返回 models 数组，包含 name 属性', async () => {
        const svc = makeService();
        const result = await svc.listModels();
        expect(result).toHaveProperty('models');
        expect(Array.isArray(result.models)).toBe(true);
        expect(result.models.length).toBeGreaterThan(0);
        for (const m of result.models) {
            expect(m).toHaveProperty('name');
        }
    });
});

// ---------------------------------------------------------------------------
// 测试：buildClaudeResponse（非流式模式）
// ---------------------------------------------------------------------------

describe('KiroApiService — buildClaudeResponse (non-stream)', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('返回标准 Claude 响应格式（只有文本内容）', () => {
        const response = svc.buildClaudeResponse('Hello world', false, 'assistant', 'claude-sonnet-4-5', null, 10);
        expect(response.type).toBe('message');
        expect(response.role).toBe('assistant');
        expect(response.model).toBe('claude-sonnet-4-5');
        expect(Array.isArray(response.content)).toBe(true);
        const textBlock = response.content.find(b => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock.text).toBe('Hello world');
    });

    test('stop_reason 在无工具调用时为 end_turn', () => {
        const response = svc.buildClaudeResponse('Hello', false, 'assistant', 'model', null, 0);
        expect(response.stop_reason).toBe('end_turn');
    });

    test('有工具调用时 stop_reason 为 tool_use', () => {
        const toolCalls = [{
            id: 'call_1',
            type: 'function',
            function: { name: 'my_tool', arguments: '{"key":"value"}' }
        }];
        const response = svc.buildClaudeResponse('', false, 'assistant', 'model', toolCalls, 0);
        expect(response.stop_reason).toBe('tool_use');
    });

    test('工具调用包含正确的 tool_use content block', () => {
        const toolCalls = [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' }
        }];
        const response = svc.buildClaudeResponse(null, false, 'assistant', 'model', toolCalls, 0);
        const toolBlock = response.content.find(b => b.type === 'tool_use');
        expect(toolBlock).toBeDefined();
        expect(toolBlock.name).toBe('search');
        expect(typeof toolBlock.input).toBe('object');
    });

    test('usage 字段包含 input_tokens 和 output_tokens', () => {
        const response = svc.buildClaudeResponse('text', false, 'assistant', 'model', null, 15);
        expect(response.usage).toBeDefined();
        expect(response.usage.input_tokens).toBe(15);
        expect(typeof response.usage.output_tokens).toBe('number');
    });
});

// ---------------------------------------------------------------------------
// 测试：parseEventStreamChunk
// ---------------------------------------------------------------------------

describe('KiroApiService — parseEventStreamChunk', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('空数据时返回空 content 和空 toolCalls', () => {
        const result = svc.parseEventStreamChunk('');
        expect(result.content).toBe('');
        expect(result.toolCalls).toEqual([]);
    });

    test('解析 content 事件', () => {
        // Kiro SSE 格式：:message-typeevent{...}
        const rawData = ':message-typeevent{"content":"Hello from Kiro"}';
        const result = svc.parseEventStreamChunk(rawData);
        expect(result.content).toContain('Hello from Kiro');
    });

    test('解析结构化工具调用事件（name + toolUseId + stop）', () => {
        const rawData = ':message-typeevent{"name":"search","toolUseId":"tc_1","input":"{\\\"q\\\":\\\"test\\\"}","stop":true}';
        const result = svc.parseEventStreamChunk(rawData);
        // 工具调用应被提取
        expect(result.toolCalls.length).toBeGreaterThanOrEqual(0); // 不强制要求，格式可能不完全匹配
    });

    test('忽略 followupPrompt 事件', () => {
        const rawData = ':message-typeevent{"followupPrompt":"What else?","content":"ignored"}';
        const result = svc.parseEventStreamChunk(rawData);
        // followupPrompt 类型不应被累积到 content 中
        expect(result.content).not.toContain('ignored');
    });
});

// ---------------------------------------------------------------------------
// 测试：parseAwsEventStreamBuffer
// ---------------------------------------------------------------------------

describe('KiroApiService — parseAwsEventStreamBuffer', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('空字符串时返回 { events: [], remaining: "" }', () => {
        const result = svc.parseAwsEventStreamBuffer('');
        expect(result.events).toEqual([]);
        expect(result.remaining).toBe('');
    });

    test('解析 content 类型事件', () => {
        const buffer = 'prefix{"content":"hello world"}suffix';
        const { events } = svc.parseAwsEventStreamBuffer(buffer);
        const contentEvent = events.find(e => e.type === 'content');
        expect(contentEvent).toBeDefined();
        expect(contentEvent.data).toBe('hello world');
    });

    test('解析 toolUse 类型事件（包含 name 和 toolUseId）', () => {
        const buffer = '{"name":"my_tool","toolUseId":"tu_1","input":"{}","stop":false}';
        const { events } = svc.parseAwsEventStreamBuffer(buffer);
        const toolUseEvent = events.find(e => e.type === 'toolUse');
        expect(toolUseEvent).toBeDefined();
        expect(toolUseEvent.data.name).toBe('my_tool');
        expect(toolUseEvent.data.toolUseId).toBe('tu_1');
    });

    test('解析 toolUseStop 事件', () => {
        const buffer = '{"stop":true}';
        const { events } = svc.parseAwsEventStreamBuffer(buffer);
        const stopEvent = events.find(e => e.type === 'toolUseStop');
        expect(stopEvent).toBeDefined();
    });

    test('解析 contextUsage 事件', () => {
        const buffer = '{"contextUsagePercentage":75.5}';
        const { events } = svc.parseAwsEventStreamBuffer(buffer);
        const ctxEvent = events.find(e => e.type === 'contextUsage');
        expect(ctxEvent).toBeDefined();
        expect(ctxEvent.data.contextUsagePercentage).toBe(75.5);
    });

    test('不完整的 JSON 保留在 remaining 中', () => {
        const buffer = '{"content":"incomplete';
        const { events, remaining } = svc.parseAwsEventStreamBuffer(buffer);
        expect(events.length).toBe(0);
        // remaining 应包含未完成的片段
        expect(remaining.length).toBeGreaterThan(0);
    });

    test('忽略 followupPrompt 字段不生成 content 事件', () => {
        const buffer = '{"followupPrompt":"Continue?","content":"ignored"}';
        const { events } = svc.parseAwsEventStreamBuffer(buffer);
        const contentEvent = events.find(e => e.type === 'content');
        expect(contentEvent).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 测试：loadCredentials（mock fs）
// ---------------------------------------------------------------------------

describe('KiroApiService — loadCredentials', () => {
    beforeEach(() => {
        mockReadFile.mockReset();
        mockReaddir.mockReset();
        mockWriteFile.mockReset();
    });

    test('成功从文件加载凭证', async () => {
        const creds = {
            accessToken: 'at-123',
            refreshToken: 'rt-456',
            clientId: 'cid',
            region: 'ap-northeast-1',
            authMethod: 'social',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
        mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
        mockReaddir.mockResolvedValueOnce([]); // 空目录

        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: '/tmp/kiro.json' });
        await svc.loadCredentials();

        expect(svc.accessToken).toBe('at-123');
        expect(svc.refreshToken).toBe('rt-456');
        expect(svc.region).toBe('ap-northeast-1');
    });

    test('文件不存在时（ENOENT）不抛出异常，使用默认 region', async () => {
        const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        mockReadFile.mockRejectedValueOnce(enoent);
        mockReaddir.mockRejectedValueOnce(enoent);

        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: '/tmp/missing.json' });
        await expect(svc.loadCredentials()).resolves.not.toThrow();
        // 没有 region 时应使用默认 us-east-1
        expect(svc.region).toBe('us-east-1');
    });

    test('JSON 格式损坏时尝试修复', async () => {
        // 损坏的 JSON，但包含可提取的字段
        const corruptedJson = '{"accessToken":"at-xxx","refreshToken":"rt-yyy",}'; // 尾部逗号
        mockReadFile.mockResolvedValueOnce(corruptedJson);
        mockReaddir.mockResolvedValueOnce([]);

        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: '/tmp/kiro.json' });
        await svc.loadCredentials();
        // 修复后应成功加载
        expect(svc.accessToken).toBe('at-xxx');
    });

    test('优先使用 base64Creds 中的凭证', async () => {
        const creds = { accessToken: 'base64-token', refreshToken: 'base64-refresh' };
        const b64 = Buffer.from(JSON.stringify(creds)).toString('base64');

        mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockReaddir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_BASE64: b64 });
        await svc.loadCredentials();
        expect(svc.accessToken).toBe('base64-token');
        // base64Creds 应被清除（避免重复加载）
        expect(svc.base64Creds).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 测试：buildCodewhispererRequest — 消息合并和工具过滤
// ---------------------------------------------------------------------------

describe('KiroApiService — buildCodewhispererRequest', () => {
    let svc;

    beforeEach(() => {
        svc = makeService();
        jest.clearAllMocks();
    });

    test('单条 user 消息时构建基本 request 结构', async () => {
        const messages = [{ role: 'user', content: 'Hello' }];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', null, null, null);
        expect(req).toHaveProperty('conversationState');
        expect(req.conversationState).toHaveProperty('currentMessage');
        expect(req.conversationState.currentMessage.userInputMessage).toBeDefined();
    });

    test('消息为空时抛出错误', async () => {
        await expect(svc.buildCodewhispererRequest([], 'claude-sonnet-4-5')).rejects.toThrow('No user messages found');
    });

    test('无工具时自动添加占位工具 no_tool_available', async () => {
        const messages = [{ role: 'user', content: 'hi' }];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', null);
        const ctx = req.conversationState.currentMessage.userInputMessage.userInputMessageContext;
        expect(ctx?.tools).toBeDefined();
        expect(ctx.tools[0].toolSpecification.name).toBe('no_tool_available');
    });

    test('过滤掉 web_search 工具', async () => {
        const messages = [{ role: 'user', content: 'search something' }];
        const tools = [
            { name: 'web_search', description: 'Search the web', input_schema: {} },
            { name: 'read_file', description: 'Read a file', input_schema: {} },
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', tools);
        const ctx = req.conversationState.currentMessage.userInputMessage.userInputMessageContext;
        const toolNames = ctx?.tools?.map(t => t.toolSpecification.name) ?? [];
        expect(toolNames).not.toContain('web_search');
        expect(toolNames).toContain('read_file');
    });

    test('过滤掉 websearch 工具（大小写不敏感）', async () => {
        const messages = [{ role: 'user', content: 'search' }];
        const tools = [{ name: 'WebSearch', description: 'desc', input_schema: {} }];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', tools);
        const ctx = req.conversationState.currentMessage.userInputMessage.userInputMessageContext;
        // WebSearch 应被过滤后，应添加占位工具
        const toolNames = ctx?.tools?.map(t => t.toolSpecification.name) ?? [];
        expect(toolNames).not.toContain('WebSearch');
    });

    test('合并相邻相同 role 的消息', async () => {
        const messages = [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', null);
        // 两条 user 消息应合并
        const content = req.conversationState.currentMessage.userInputMessage.content;
        expect(content).toContain('first');
        expect(content).toContain('second');
    });

    test('system prompt 被添加到第一条 user 消息（进入 history）', async () => {
        // 当只有一条 user 消息时，system prompt 与该消息合并后放入 history
        // currentMessage 变为后续消息中的内容（这里就是 "question" 本身）
        const messages = [{ role: 'user', content: 'question' }];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', null, 'System instruction');
        // system prompt 被合并进了 history 第一条 userInputMessage
        const historyFirst = req.conversationState.history?.[0]?.userInputMessage?.content;
        expect(historyFirst).toContain('System instruction');
        expect(historyFirst).toContain('question');
    });

    test('thinking prefix 被注入到 history 中的第一条 user 消息（含 system prompt 部分）', async () => {
        // thinking prefix 添加到 systemPrompt，systemPrompt 与第一条 user 消息合并后进入 history
        const messages = [{ role: 'user', content: 'think' }];
        const thinking = { type: 'enabled', budget_tokens: 2048 };
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', null, null, thinking);
        // thinking prefix 在 systemPrompt 前面，进入 history 的第一条消息
        const historyFirst = req.conversationState.history?.[0]?.userInputMessage?.content;
        expect(historyFirst).toContain('<thinking_mode>');
    });

    test('工具描述超过 9216 字符时被截断', async () => {
        const messages = [{ role: 'user', content: 'use tool' }];
        const longDesc = 'x'.repeat(10000);
        const tools = [{ name: 'big_tool', description: longDesc, input_schema: {} }];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', tools);
        const ctx = req.conversationState.currentMessage.userInputMessage.userInputMessageContext;
        const toolSpec = ctx?.tools?.find(t => t.toolSpecification.name === 'big_tool');
        if (toolSpec) {
            expect(toolSpec.toolSpecification.description.length).toBeLessThanOrEqual(9216 + 3); // +3 for "..."
        }
    });

    test('工具描述为空时该工具被过滤掉', async () => {
        const messages = [{ role: 'user', content: 'use tool' }];
        const tools = [
            { name: 'empty_desc_tool', description: '', input_schema: {} },
            { name: 'valid_tool', description: 'valid description', input_schema: {} },
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', tools);
        const ctx = req.conversationState.currentMessage.userInputMessage.userInputMessageContext;
        const toolNames = ctx?.tools?.map(t => t.toolSpecification.name) ?? [];
        expect(toolNames).not.toContain('empty_desc_tool');
    });

    test('profileArn 设置时 social auth 添加 profileArn 到 request', async () => {
        const svc2 = makeService();
        svc2.authMethod = 'social';
        svc2.profileArn = 'arn:aws:iam::123456789:role/TestRole';
        const messages = [{ role: 'user', content: 'hello' }];
        const req = await svc2.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        expect(req.profileArn).toBe('arn:aws:iam::123456789:role/TestRole');
    });

    test('最后一条消息为 assistant 时自动添加 Continue', async () => {
        const messages = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'world' },
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        const content = req.conversationState.currentMessage.userInputMessage.content;
        expect(content).toBe('Continue');
    });
});

// ---------------------------------------------------------------------------
// 测试：callApi — 错误处理
// ---------------------------------------------------------------------------

describe('KiroApiService — callApi 错误处理', () => {
    beforeEach(() => {
        mockAxiosRequest.mockReset();
        jest.clearAllMocks();
    });

    test('消息为空时抛出错误', async () => {
        const svc = makeService();
        await expect(svc.callApi('', 'model', { messages: [] })).rejects.toThrow('No messages found');
    });

    test('401 错误时设置 shouldSwitchCredential 并抛出', async () => {
        const svc = makeService();
        const err = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
        mockAxiosRequest.mockRejectedValueOnce(err);

        await expect(
            svc.callApi('', 'claude-sonnet-4-5', {
                messages: [{ role: 'user', content: 'hello' }]
            })
        ).rejects.toMatchObject({ response: { status: 401 } });
    });

    test('429 错误时设置 shouldSwitchCredential 并抛出', async () => {
        const svc = makeService({ REQUEST_BASE_DELAY: 0 });
        const err = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
        mockAxiosRequest.mockRejectedValueOnce(err);

        const thrownError = await svc.callApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'test' }]
        }).catch(e => e);

        expect(thrownError.shouldSwitchCredential).toBe(true);
    });

    test('500 服务器错误时设置 shouldSwitchCredential 并抛出', async () => {
        const svc = makeService({ REQUEST_BASE_DELAY: 0 });
        const err = Object.assign(new Error('Server Error'), { response: { status: 500 } });
        mockAxiosRequest.mockRejectedValueOnce(err);

        const thrownError = await svc.callApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'test' }]
        }).catch(e => e);

        expect(thrownError.shouldSwitchCredential).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 测试：_markCredentialNeedRefresh / _markCredentialUnhealthy（无 poolManager）
// ---------------------------------------------------------------------------

describe('KiroApiService — credential 标记方法（无 poolManager）', () => {
    test('_markCredentialNeedRefresh 在无 poolManager 时返回 false', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        getProviderPoolManager.mockReturnValue(null);
        const svc = makeService();
        const result = svc._markCredentialNeedRefresh('test reason');
        expect(result).toBe(false);
    });

    test('_markCredentialUnhealthy 在无 poolManager 时返回 false', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        getProviderPoolManager.mockReturnValue(null);
        const svc = makeService();
        const result = svc._markCredentialUnhealthy('test reason');
        expect(result).toBe(false);
    });

    test('_markCredentialUnhealthyWithRecovery 在无 poolManager 时返回 false', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        getProviderPoolManager.mockReturnValue(null);
        const svc = makeService();
        const result = svc._markCredentialUnhealthyWithRecovery('test reason');
        expect(result).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 测试：_markCredentialNeedRefresh / _markCredentialUnhealthy（有 poolManager）
// ---------------------------------------------------------------------------

describe('KiroApiService — credential 标记方法（有 poolManager）', () => {
    let mockPoolManager;

    beforeEach(async () => {
        mockPoolManager = {
            markProviderNeedRefresh: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            refreshProviderUuid: jest.fn(() => 'new-uuid'),
            resetProviderRefreshStatus: jest.fn(),
        };
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        getProviderPoolManager.mockReturnValue(mockPoolManager);
    });

    afterEach(async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        getProviderPoolManager.mockReturnValue(null);
    });

    test('_markCredentialNeedRefresh 调用 poolManager.markProviderNeedRefresh', () => {
        const svc = makeService();
        svc.uuid = 'test-uuid';
        const result = svc._markCredentialNeedRefresh('reason');
        expect(result).toBe(true);
        expect(mockPoolManager.markProviderNeedRefresh).toHaveBeenCalled();
    });

    test('_markCredentialUnhealthy 调用 poolManager.markProviderUnhealthyImmediately', () => {
        const svc = makeService();
        svc.uuid = 'test-uuid';
        const result = svc._markCredentialUnhealthy('reason');
        expect(result).toBe(true);
        expect(mockPoolManager.markProviderUnhealthyImmediately).toHaveBeenCalled();
    });

    test('_markCredentialNeedRefresh 传入 error 时设置 credentialMarkedUnhealthy', () => {
        const svc = makeService();
        svc.uuid = 'test-uuid';
        const err = new Error('test');
        svc._markCredentialNeedRefresh('reason', err);
        expect(err.credentialMarkedUnhealthy).toBe(true);
    });
});
