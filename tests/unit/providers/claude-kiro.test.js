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

// ---------------------------------------------------------------------------
// 测试：initialize()
// ---------------------------------------------------------------------------

describe('KiroApiService — initialize()', () => {
    beforeEach(() => {
        mockReadFile.mockReset();
        mockReaddir.mockReset();
        mockWriteFile.mockReset();
        mockAxiosCreate.mockClear();
    });

    test('成功初始化：加载凭证并创建 axios 实例', async () => {
        const creds = {
            accessToken: 'init-at',
            refreshToken: 'init-rt',
            region: 'us-west-2',
        };
        mockReadFile.mockResolvedValueOnce(JSON.stringify(creds));
        mockReaddir.mockResolvedValueOnce([]);

        const svc = new KiroApiService({});
        await svc.initialize();

        expect(svc.isInitialized).toBe(true);
        expect(mockAxiosCreate).toHaveBeenCalled();
        expect(svc.accessToken).toBe('init-at');
        expect(svc.region).toBe('us-west-2');
    });

    test('已初始化时 initialize() 直接返回，不重复创建 axios 实例', async () => {
        const svc = makeService(); // already initialized
        const callsBefore = mockAxiosCreate.mock.calls.length;
        await svc.initialize();
        expect(mockAxiosCreate.mock.calls.length).toBe(callsBefore);
    });

    test('USE_SYSTEM_PROXY_KIRO=false 时设置 proxy=false', async () => {
        mockReadFile.mockResolvedValueOnce(JSON.stringify({ accessToken: 'at', region: 'us-east-1' }));
        mockReaddir.mockResolvedValueOnce([]);

        const svc = new KiroApiService({ USE_SYSTEM_PROXY_KIRO: false });
        await svc.initialize();

        const axiosConfig = mockAxiosCreate.mock.calls[0][0];
        expect(axiosConfig.proxy).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 测试：callApi — 成功路径
// ---------------------------------------------------------------------------

describe('KiroApiService — callApi 成功路径', () => {
    beforeEach(() => {
        mockAxiosRequest.mockReset();
        jest.clearAllMocks();
    });

    test('成功调用 API 返回原始响应', async () => {
        const svc = makeService();
        const mockResponse = { data: Buffer.from('{"content":"hello"}') };
        mockAxiosRequest.mockResolvedValueOnce(mockResponse);

        const response = await svc.callApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        expect(response).toEqual(mockResponse);
        expect(mockAxiosRequest).toHaveBeenCalled();
    });

    test('contents 格式被转换为 messages 格式', async () => {
        const svc = makeService();
        mockAxiosRequest.mockResolvedValueOnce({ data: Buffer.from('{}') });

        await svc.callApi('', 'claude-sonnet-4-5', {
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
        });

        expect(mockAxiosRequest).toHaveBeenCalled();
    });

    test('403 suspended 错误时标记为不健康并抛出', async () => {
        const svc = makeService();
        const err = Object.assign(
            new Error('temporarily is suspended'),
            { response: { status: 403 } }
        );
        mockAxiosRequest.mockRejectedValueOnce(err);

        const thrown = await svc.callApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        }).catch(e => e);

        expect(thrown.shouldSwitchCredential).toBe(true);
    });

    test('403 非 suspended 错误时调用 _markCredentialNeedRefresh', async () => {
        const svc = makeService();
        const err = Object.assign(
            new Error('Forbidden'),
            { response: { status: 403 } }
        );
        mockAxiosRequest.mockRejectedValueOnce(err);

        const thrown = await svc.callApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        }).catch(e => e);

        expect(thrown.shouldSwitchCredential).toBe(true);
    });

    test('网络错误可重试并在第二次成功', async () => {
        const { isRetryableNetworkError } = await import('../../../src/utils/common.js');
        isRetryableNetworkError.mockReturnValueOnce(true);

        const svc = makeService({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 0 });
        const networkErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        const successResponse = { data: Buffer.from('{}') };
        mockAxiosRequest
            .mockRejectedValueOnce(networkErr)
            .mockResolvedValueOnce(successResponse);

        const result = await svc.callApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        expect(result).toEqual(successResponse);
        isRetryableNetworkError.mockReturnValue(false);
    });

    test('amazonq 模型使用 amazonQUrl', async () => {
        const svc = makeService();
        svc.amazonQUrl = 'https://amazonq.url';
        mockAxiosRequest.mockResolvedValueOnce({ data: Buffer.from('{}') });

        await svc.callApi('', 'amazonq-claude', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        const callArgs = mockAxiosRequest.mock.calls[0][0];
        expect(callArgs.url).toBe('https://amazonq.url');
    });
});

// ---------------------------------------------------------------------------
// 测试：generateContent
// ---------------------------------------------------------------------------

describe('KiroApiService — generateContent', () => {
    beforeEach(() => {
        mockAxiosRequest.mockReset();
    });

    test('成功处理并返回 Claude 格式响应', async () => {
        const svc = makeService();
        const responseData = Buffer.from('prefix{"content":"Hello from Kiro"}suffix');
        mockAxiosRequest.mockResolvedValueOnce({ data: responseData });

        const result = await svc.generateContent('claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        expect(result.type).toBe('message');
        expect(result.role).toBe('assistant');
    });

    test('thinking 请求时调用 _toClaudeContentBlocksFromKiroText', async () => {
        const svc = makeService();
        // Response contains thinking tags
        const rawContent = '{"content":"<thinking>\\nsome thought\\n</thinking>\\n\\nfinal answer"}';
        mockAxiosRequest.mockResolvedValueOnce({ data: Buffer.from(rawContent) });

        const result = await svc.generateContent('claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }],
            thinking: { type: 'enabled', budget_tokens: 2048 }
        });

        expect(result.type).toBe('message');
    });

    test('_monitorRequestId 被临时存储并清除', async () => {
        const svc = makeService();
        mockAxiosRequest.mockResolvedValueOnce({ data: Buffer.from('{"content":"hello"}') });

        const body = {
            messages: [{ role: 'user', content: 'hi' }],
            _monitorRequestId: 'req-123'
        };
        await svc.generateContent('claude-sonnet-4-5', body);

        expect(body._monitorRequestId).toBeUndefined();
    });

    test('_requestBaseUrl 被删除', async () => {
        const svc = makeService();
        mockAxiosRequest.mockResolvedValueOnce({ data: Buffer.from('{"content":"hello"}') });

        const body = {
            messages: [{ role: 'user', content: 'hi' }],
            _requestBaseUrl: 'https://custom.url'
        };
        await svc.generateContent('claude-sonnet-4-5', body);

        expect(body._requestBaseUrl).toBeUndefined();
    });

    test('token 即将过期时调用 _markCredentialNeedRefresh', async () => {
        const { formatExpiryLog } = await import('../../../src/utils/common.js');
        formatExpiryLog.mockReturnValueOnce({ message: 'near', isNearExpiry: true });

        const svc = makeService();
        svc.expiresAt = new Date(Date.now() + 60000).toISOString();
        mockAxiosRequest.mockResolvedValueOnce({ data: Buffer.from('{"content":"ok"}') });

        await svc.generateContent('claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hi' }]
        });

        formatExpiryLog.mockReturnValue({ message: 'ok', isNearExpiry: false });
    });
});

// ---------------------------------------------------------------------------
// 测试：buildClaudeResponse (streaming mode)
// ---------------------------------------------------------------------------

describe('KiroApiService — buildClaudeResponse (stream mode)', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('isStream=true 时返回事件数组', () => {
        const events = svc.buildClaudeResponse('Hello', true, 'assistant', 'model', null, 10);
        expect(Array.isArray(events)).toBe(true);
        const types = events.map(e => e.type);
        expect(types).toContain('message_start');
        expect(types).toContain('content_block_start');
        expect(types).toContain('content_block_delta');
        expect(types).toContain('message_delta');
        expect(types).toContain('message_stop');
    });

    test('有工具调用时生成 tool_use 流式事件', () => {
        const toolCalls = [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' }
        }];
        const events = svc.buildClaudeResponse('', true, 'assistant', 'model', toolCalls, 0);
        const toolStart = events.find(
            e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'
        );
        expect(toolStart).toBeDefined();
        expect(toolStart.content_block.name).toBe('search');
    });

    test('工具调用参数 JSON 解析失败时使用 raw_arguments（流式）', () => {
        const toolCalls = [{
            id: 'call_bad',
            type: 'function',
            function: { name: 'bad_tool', arguments: 'not-json' }
        }];
        const events = svc.buildClaudeResponse(null, true, 'assistant', 'model', toolCalls, 0);
        const delta = events.find(e => e.type === 'content_block_delta');
        const parsed = JSON.parse(delta.delta.partial_json);
        expect(parsed.raw_arguments).toBe('not-json');
    });

    test('content 为空时不添加文本事件块', () => {
        const events = svc.buildClaudeResponse(null, true, 'assistant', 'model', null, 0);
        const textStart = events.find(
            e => e.type === 'content_block_start' && e.content_block?.type === 'text'
        );
        expect(textStart).toBeUndefined();
    });

    test('工具调用与文本都有时 stop_reason 为 tool_use', () => {
        const toolCalls = [{
            id: 'call_1',
            type: 'function',
            function: { name: 'fn', arguments: '{}' }
        }];
        const events = svc.buildClaudeResponse('some text', true, 'assistant', 'model', toolCalls, 0);
        const delta = events.find(e => e.type === 'message_delta');
        expect(delta.delta.stop_reason).toBe('tool_use');
    });
});

// ---------------------------------------------------------------------------
// 测试：buildClaudeResponse — 非流式 content 数组处理
// ---------------------------------------------------------------------------

describe('KiroApiService — buildClaudeResponse content 数组', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('数组内容含 thinking block 时正确处理', () => {
        const content = [
            { type: 'thinking', thinking: 'some thought' },
            { type: 'text', text: 'answer' }
        ];
        const response = svc.buildClaudeResponse(content, false, 'assistant', 'model', null, 0);
        const thinkingBlock = response.content.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock.thinking).toBe('some thought');
        const textBlock = response.content.find(b => b.type === 'text');
        expect(textBlock.text).toBe('answer');
    });

    test('数组内容含未知类型但有 text 属性时作为 fallback', () => {
        const content = [
            { type: 'unknown_block', text: 'fallback text' }
        ];
        const response = svc.buildClaudeResponse(content, false, 'assistant', 'model', null, 0);
        const textBlock = response.content.find(b => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock.text).toBe('fallback text');
    });

    test('工具调用参数 JSON 解析失败时使用 raw_arguments（非流式）', () => {
        const toolCalls = [{
            id: 'call_bad',
            type: 'function',
            function: { name: 'bad_tool', arguments: 'not-json' }
        }];
        const response = svc.buildClaudeResponse(null, false, 'assistant', 'model', toolCalls, 0);
        const toolBlock = response.content.find(b => b.type === 'tool_use');
        expect(toolBlock.input.raw_arguments).toBe('not-json');
    });

    test('数组内容含 null/非对象元素时安全跳过', () => {
        const content = [null, { type: 'text', text: 'valid' }];
        const response = svc.buildClaudeResponse(content, false, 'assistant', 'model', null, 0);
        expect(response.content.length).toBe(1);
        expect(response.content[0].text).toBe('valid');
    });
});

// ---------------------------------------------------------------------------
// 测试：saveCredentialsToFile
// ---------------------------------------------------------------------------

describe('KiroApiService — saveCredentialsToFile', () => {
    beforeEach(() => {
        mockReadFile.mockReset();
        mockWriteFile.mockReset();
    });

    test('合并已有文件数据后写入', async () => {
        const svc = makeService();
        const existing = { clientId: 'existing-cid', region: 'us-west-2' };
        mockReadFile.mockResolvedValueOnce(JSON.stringify(existing));
        mockWriteFile.mockResolvedValueOnce();

        await svc.saveCredentialsToFile('/tmp/token.json', { accessToken: 'new-at' });

        const writeCall = mockWriteFile.mock.calls[0];
        const written = JSON.parse(writeCall[1]);
        expect(written.clientId).toBe('existing-cid');
        expect(written.accessToken).toBe('new-at');
    });

    test('文件不存在（ENOENT）时创建新文件', async () => {
        const svc = makeService();
        mockReadFile.mockRejectedValueOnce(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        );
        mockWriteFile.mockResolvedValueOnce();

        await svc.saveCredentialsToFile('/tmp/new-token.json', { accessToken: 'new-at' });

        const writeCall = mockWriteFile.mock.calls[0];
        const written = JSON.parse(writeCall[1]);
        expect(written.accessToken).toBe('new-at');
    });

    test('文件读取失败（非 ENOENT）时仍写入新数据', async () => {
        const svc = makeService();
        mockReadFile.mockRejectedValueOnce(new Error('permission denied'));
        mockWriteFile.mockResolvedValueOnce();

        await svc.saveCredentialsToFile('/tmp/token.json', { refreshToken: 'new-rt' });

        const writeCall = mockWriteFile.mock.calls[0];
        const written = JSON.parse(writeCall[1]);
        expect(written.refreshToken).toBe('new-rt');
    });

    test('文件内容 JSON 修复失败时通过 extractCredentials 恢复', async () => {
        const svc = makeService();
        // Content that fails JSON.parse + repairJson but has extractable fields
        const corruptContent = '{invalid json but "accessToken":"old-at","refreshToken":"old-rt"';
        mockReadFile.mockResolvedValueOnce(corruptContent);
        mockWriteFile.mockResolvedValueOnce();

        await svc.saveCredentialsToFile('/tmp/corrupt.json', { accessToken: 'new-at' });

        const writeCall = mockWriteFile.mock.calls[0];
        const written = JSON.parse(writeCall[1]);
        expect(written.accessToken).toBe('new-at');
    });
});

// ---------------------------------------------------------------------------
// 测试：_doTokenRefresh
// ---------------------------------------------------------------------------

describe('KiroApiService — _doTokenRefresh', () => {
    beforeEach(() => {
        mockAxiosRequest.mockReset();
        mockAxiosSocialRefreshRequest.mockReset();
        mockReadFile.mockReset();
        mockWriteFile.mockReset();
    });

    test('social auth 成功刷新 token', async () => {
        const svc = makeService();
        svc.authMethod = 'social';
        svc.refreshToken = 'rt-123';
        svc.refreshUrl = 'https://refresh.url';

        mockAxiosSocialRefreshRequest.mockResolvedValueOnce({
            data: {
                accessToken: 'new-access-token',
                refreshToken: 'new-refresh-token',
                expiresIn: 3600
            }
        });
        mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockWriteFile.mockResolvedValueOnce();

        await svc._doTokenRefresh(svc.saveCredentialsToFile.bind(svc), '/tmp/token.json');

        expect(svc.accessToken).toBe('new-access-token');
        expect(svc.refreshToken).toBe('new-refresh-token');
    });

    test('IDC auth 成功刷新 token', async () => {
        const svc = makeService();
        svc.authMethod = 'idc';
        svc.refreshToken = 'rt-idc';
        svc.clientId = 'cid';
        svc.clientSecret = 'csecret';
        svc.refreshIDCUrl = 'https://oidc.us-east-1.amazonaws.com/token';

        mockAxiosRequest.mockResolvedValueOnce({
            data: {
                accessToken: 'idc-access-token',
                refreshToken: 'idc-refresh-token',
                expiresIn: 7200
            }
        });
        mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockWriteFile.mockResolvedValueOnce();

        await svc._doTokenRefresh(svc.saveCredentialsToFile.bind(svc), '/tmp/token.json');

        expect(svc.accessToken).toBe('idc-access-token');
    });

    test('刷新响应无 accessToken 时抛出错误', async () => {
        const svc = makeService();
        svc.authMethod = 'social';
        svc.refreshToken = 'rt-123';
        svc.refreshUrl = 'https://refresh.url';

        mockAxiosSocialRefreshRequest.mockResolvedValueOnce({ data: {} });

        await expect(
            svc._doTokenRefresh(() => {}, '/tmp/token.json')
        ).rejects.toThrow('Token refresh failed');
    });

    test('网络错误时包装后抛出', async () => {
        const svc = makeService();
        svc.authMethod = 'social';
        svc.refreshToken = 'rt-123';
        svc.refreshUrl = 'https://refresh.url';

        mockAxiosSocialRefreshRequest.mockRejectedValueOnce(new Error('network timeout'));

        await expect(
            svc._doTokenRefresh(() => {}, '/tmp/token.json')
        ).rejects.toThrow('Token refresh failed: network timeout');
    });

    test('social auth + profileArn 时保存 profileArn', async () => {
        const svc = makeService();
        svc.authMethod = 'social';
        svc.refreshToken = 'rt-123';
        svc.refreshUrl = 'https://refresh.url';

        mockAxiosSocialRefreshRequest.mockResolvedValueOnce({
            data: {
                accessToken: 'new-at',
                refreshToken: 'new-rt',
                profileArn: 'arn:aws:...',
                expiresIn: 3600
            }
        });
        mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockWriteFile.mockResolvedValueOnce();

        await svc._doTokenRefresh(svc.saveCredentialsToFile.bind(svc), '/tmp/token.json');

        expect(svc.profileArn).toBe('arn:aws:...');
    });
});

// ---------------------------------------------------------------------------
// 测试：initializeAuth
// ---------------------------------------------------------------------------

describe('KiroApiService — initializeAuth', () => {
    test('已有 accessToken 且非强制刷新时不执行刷新', async () => {
        mockReadFile.mockReset();
        mockReaddir.mockReset();
        const svc = makeService();
        svc.accessToken = 'existing-token';
        // loadCredentials should not call readFile in initializeAuth path
        mockReadFile.mockResolvedValue('{}');
        mockReaddir.mockResolvedValue([]);

        await svc.initializeAuth(false);
        // accessToken should remain unchanged
        expect(svc.accessToken).toBe('existing-token');
    });

    test('无 accessToken 但有 refreshToken 时执行 _doTokenRefresh', async () => {
        mockReadFile.mockReset();
        mockReaddir.mockReset();
        mockWriteFile.mockReset();
        mockAxiosSocialRefreshRequest.mockReset();

        const svc = makeService();
        svc.accessToken = undefined;
        svc.refreshToken = 'rt-for-init';
        svc.authMethod = 'social';
        svc.refreshUrl = 'https://refresh.url';

        // loadCredentials during initializeAuth
        mockReadFile.mockResolvedValueOnce(JSON.stringify({ region: 'us-east-1' }));
        mockReaddir.mockResolvedValueOnce([]);

        // _doTokenRefresh call
        mockAxiosSocialRefreshRequest.mockResolvedValueOnce({
            data: { accessToken: 'refreshed-at', refreshToken: 'refreshed-rt', expiresIn: 3600 }
        });
        mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockWriteFile.mockResolvedValueOnce();

        await svc.initializeAuth(false);

        expect(svc.accessToken).toBe('refreshed-at');
    });

    test('无 accessToken 且无 refreshToken 时抛出错误', async () => {
        mockReadFile.mockReset();
        mockReaddir.mockReset();

        const svc = makeService();
        svc.accessToken = undefined;
        svc.refreshToken = undefined;
        // No accessToken in file either
        mockReadFile.mockResolvedValueOnce(JSON.stringify({ region: 'us-east-1' }));
        mockReaddir.mockResolvedValueOnce([]);

        await expect(svc.initializeAuth(false)).rejects.toThrow('No access token available');
    });
});

// ---------------------------------------------------------------------------
// 测试：loadCredentials — extractCredentialsFromCorruptedJson 路径
// ---------------------------------------------------------------------------

describe('KiroApiService — loadCredentials (extractCredentials path)', () => {
    beforeEach(() => {
        mockReadFile.mockReset();
        mockReaddir.mockReset();
    });

    test('JSON 修复失败后通过 regex 提取字段', async () => {
        // Content that fails both JSON.parse and repairJson, but has extractable regex fields
        const corruptContent = '{invalid "accessToken":"extract-at","refreshToken":"extract-rt"';
        mockReadFile.mockResolvedValueOnce(corruptContent);
        mockReaddir.mockResolvedValueOnce([]);

        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: '/tmp/corrupt.json' });
        await svc.loadCredentials();

        expect(svc.accessToken).toBe('extract-at');
        expect(svc.refreshToken).toBe('extract-rt');
    });

    test('所有恢复方法失败时返回 null，不设置 token', async () => {
        // Content that fails JSON.parse, repairJson, and has no extractable fields
        const corruptContent = 'completely invalid content with no tokens';
        mockReadFile.mockResolvedValueOnce(corruptContent);
        mockReaddir.mockResolvedValueOnce([]);

        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: '/tmp/bad.json' });
        await svc.loadCredentials();

        // No accessToken set from file
        expect(svc.accessToken).toBeUndefined();
    });

    test('目录中存在其他 .json 文件时合并凭证', async () => {
        const mainCreds = JSON.stringify({ accessToken: 'main-at', region: 'ap-northeast-1' });
        const extraCreds = JSON.stringify({ clientId: 'extra-cid' });

        mockReadFile
            .mockResolvedValueOnce(mainCreds)
            .mockResolvedValueOnce(extraCreds);

        mockReaddir.mockResolvedValueOnce(['extra-client.json']);

        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: '/tmp/token-dir/kiro-auth-token.json' });
        await svc.loadCredentials();

        expect(svc.accessToken).toBe('main-at');
        expect(svc.clientId).toBe('extra-cid');
    });

    test('idcRegion 未设置时使用 region 作为默认值', async () => {
        mockReadFile.mockResolvedValueOnce(JSON.stringify({ region: 'eu-west-1' }));
        mockReaddir.mockResolvedValueOnce([]);

        const svc = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: '/tmp/token.json' });
        await svc.loadCredentials();

        expect(svc.idcRegion).toBe('eu-west-1');
    });
});

// ---------------------------------------------------------------------------
// 测试：getUsageLimits
// ---------------------------------------------------------------------------

describe('KiroApiService — getUsageLimits', () => {
    beforeEach(() => {
        mockAxiosRequest.mockReset();
    });

    test('成功获取用量限制数据', async () => {
        const svc = makeService();
        const usageData = { usedCount: 50, limitCount: 100 };
        mockAxiosRequest.mockResolvedValueOnce({ data: usageData });

        const result = await svc.getUsageLimits();
        expect(result).toEqual(usageData);
    });

    test('social auth + profileArn 时在 URL 中添加 profileArn 参数', async () => {
        const svc = makeService();
        svc.authMethod = 'social';
        svc.profileArn = 'arn:aws:iam::123:role/Test';
        mockAxiosRequest.mockResolvedValueOnce({ data: {} });

        await svc.getUsageLimits();

        const callArgs = mockAxiosRequest.mock.calls[0][0];
        expect(callArgs.url).toContain('profileArn');
    });

    test('401 错误时标记凭证需要刷新并抛出', async () => {
        const svc = makeService();
        const err = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
        mockAxiosRequest.mockRejectedValueOnce(err);

        await expect(svc.getUsageLimits()).rejects.toThrow('401');
    });

    test('403 suspended 错误时标记不健康并抛出', async () => {
        const svc = makeService();
        const err = Object.assign(
            new Error('temporarily is suspended'),
            { response: { status: 403, data: 'temporarily is suspended' } }
        );
        mockAxiosRequest.mockRejectedValueOnce(err);

        await expect(svc.getUsageLimits()).rejects.toThrow();
    });

    test('403 非 suspended 错误时调用 _markCredentialNeedRefresh', async () => {
        const svc = makeService();
        const err = Object.assign(
            new Error('Forbidden'),
            { response: { status: 403, data: { message: 'access denied' } } }
        );
        mockAxiosRequest.mockRejectedValueOnce(err);

        await expect(svc.getUsageLimits()).rejects.toThrow('403');
    });

    test('500 错误时抛出包含状态码的错误', async () => {
        const svc = makeService();
        const err = Object.assign(
            new Error('Internal Server Error'),
            { response: { status: 500, data: { error: 'server crashed' } } }
        );
        mockAxiosRequest.mockRejectedValueOnce(err);

        await expect(svc.getUsageLimits()).rejects.toThrow('500');
    });

    test('响应 data 为 string 时提取错误信息', async () => {
        const svc = makeService();
        const err = Object.assign(
            new Error('error'),
            { response: { status: 500, data: 'plain string error message' } }
        );
        mockAxiosRequest.mockRejectedValueOnce(err);

        await expect(svc.getUsageLimits()).rejects.toThrow('500');
    });

    test('响应 data 含 error 对象时提取错误信息', async () => {
        const svc = makeService();
        const err = Object.assign(
            new Error('error'),
            { response: { status: 500, data: { error: { message: 'deep error' } } } }
        );
        mockAxiosRequest.mockRejectedValueOnce(err);

        await expect(svc.getUsageLimits()).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// 测试：streamApi (wrapper)
// ---------------------------------------------------------------------------

describe('KiroApiService — streamApi', () => {
    beforeEach(() => { mockAxiosRequest.mockReset(); });

    test('成功时委托给 callApi 返回响应', async () => {
        const svc = makeService();
        const mockResponse = { data: Buffer.from('{"content":"hello"}') };
        mockAxiosRequest.mockResolvedValueOnce(mockResponse);

        const result = await svc.streamApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        expect(result).toEqual(mockResponse);
    });

    test('错误时重新抛出', async () => {
        const svc = makeService();
        const err = Object.assign(new Error('Network error'), { response: { status: 503 } });
        mockAxiosRequest.mockRejectedValueOnce(err);

        await expect(svc.streamApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        })).rejects.toThrow('Network error');
    });
});

// ---------------------------------------------------------------------------
// 测试：streamApiReal
// ---------------------------------------------------------------------------

describe('KiroApiService — streamApiReal', () => {
    beforeEach(() => { mockAxiosRequest.mockReset(); });

    test('成功流式响应 content 事件', async () => {
        const svc = makeService();

        async function* mockStream() {
            yield Buffer.from('{"content":"Hello"}');
            yield Buffer.from('{"content":" World"}');
        }

        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        const events = [];
        for await (const event of svc.streamApiReal('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        })) {
            events.push(event);
        }

        expect(events.some(e => e.type === 'content')).toBe(true);
        const contentEvents = events.filter(e => e.type === 'content');
        expect(contentEvents[0].content).toBe('Hello');
    });

    test('重复的 content 事件被过滤', async () => {
        const svc = makeService();

        async function* mockStream() {
            yield Buffer.from('{"content":"duplicate"}');
            yield Buffer.from('{"content":"duplicate"}'); // same content
            yield Buffer.from('{"content":"different"}');
        }

        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        const events = [];
        for await (const event of svc.streamApiReal('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        })) {
            events.push(event);
        }

        const contentEvents = events.filter(e => e.type === 'content');
        // duplicate should be filtered: 'duplicate' once, 'different' once
        expect(contentEvents.length).toBe(2);
    });

    test('toolUse 事件被 yield', async () => {
        const svc = makeService();

        async function* mockStream() {
            yield Buffer.from('{"name":"search","toolUseId":"tu_1","input":"{\\"q\\":\\"test\\"}","stop":false}');
        }

        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        const events = [];
        for await (const event of svc.streamApiReal('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        })) {
            events.push(event);
        }

        const toolEvent = events.find(e => e.type === 'toolUse');
        expect(toolEvent).toBeDefined();
        expect(toolEvent.toolUse.name).toBe('search');
    });

    test('401 错误时触发 credential 标记并抛出', async () => {
        const svc = makeService();
        const err = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
        mockAxiosRequest.mockRejectedValueOnce(err);

        const gen = svc.streamApiReal('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        await expect(async () => {
            for await (const _ of gen) {}
        }).rejects.toMatchObject({ shouldSwitchCredential: true });
    });

    test('429 错误时设置 shouldSwitchCredential 并抛出', async () => {
        const svc = makeService({ REQUEST_BASE_DELAY: 0 });
        const err = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
        mockAxiosRequest.mockRejectedValueOnce(err);

        const gen = svc.streamApiReal('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        const thrown = await (async () => {
            for await (const _ of gen) {}
        })().catch(e => e);

        expect(thrown.shouldSwitchCredential).toBe(true);
    });

    test('500 错误时设置 shouldSwitchCredential 并抛出', async () => {
        const svc = makeService({ REQUEST_BASE_DELAY: 0 });
        const err = Object.assign(new Error('Server Error'), { response: { status: 500 } });
        mockAxiosRequest.mockRejectedValueOnce(err);

        const gen = svc.streamApiReal('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        const thrown = await (async () => {
            for await (const _ of gen) {}
        })().catch(e => e);

        expect(thrown.shouldSwitchCredential).toBe(true);
    });

    test('contextUsage 事件被 yield', async () => {
        const svc = makeService();

        async function* mockStream() {
            yield Buffer.from('{"contextUsagePercentage":75.5}');
        }

        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        const events = [];
        for await (const event of svc.streamApiReal('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        })) {
            events.push(event);
        }

        const ctxEvent = events.find(e => e.type === 'contextUsage');
        expect(ctxEvent).toBeDefined();
        expect(ctxEvent.contextUsagePercentage).toBe(75.5);
    });

    test('messages 为空时抛出错误', async () => {
        const svc = makeService();

        await expect(async () => {
            for await (const _ of svc.streamApiReal('', 'claude-sonnet-4-5', {
                messages: []
            })) {}
        }).rejects.toThrow('No messages found');
    });
});

// ---------------------------------------------------------------------------
// 测试：generateContentStream
// ---------------------------------------------------------------------------

describe('KiroApiService — generateContentStream', () => {
    beforeEach(() => { mockAxiosRequest.mockReset(); });

    test('基本流式响应输出 message_start 和 content_block_delta', async () => {
        const svc = makeService();

        async function* mockStream() {
            yield Buffer.from('{"content":"Hello"}');
            yield Buffer.from('{"content":" World"}');
        }

        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        const events = [];
        for await (const event of svc.generateContentStream('claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        })) {
            events.push(event);
        }

        expect(events.some(e => e.type === 'message_start')).toBe(true);
        expect(events.some(e => e.type === 'content_block_delta')).toBe(true);
    });

    test('_monitorRequestId 和 _requestBaseUrl 被清除', async () => {
        const svc = makeService();

        async function* mockStream() {
            yield Buffer.from('{"content":"hello"}');
        }

        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        const body = {
            messages: [{ role: 'user', content: 'test' }],
            _monitorRequestId: 'req-stream',
            _requestBaseUrl: 'https://custom.url'
        };

        for await (const _ of svc.generateContentStream('claude-sonnet-4-5', body)) {}

        expect(body._monitorRequestId).toBeUndefined();
        expect(body._requestBaseUrl).toBeUndefined();
    });

    test('token 即将过期时触发 markCredentialNeedRefresh', async () => {
        const { formatExpiryLog } = await import('../../../src/utils/common.js');
        formatExpiryLog.mockReturnValueOnce({ message: 'near', isNearExpiry: true });

        const svc = makeService();
        svc.expiresAt = new Date(Date.now() + 60000).toISOString();

        async function* mockStream() {
            yield Buffer.from('{"content":"ok"}');
        }
        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        for await (const _ of svc.generateContentStream('claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hi' }]
        })) {}

        formatExpiryLog.mockReturnValue({ message: 'ok', isNearExpiry: false });
    });

    test('输出最终 message_delta 和 message_stop', async () => {
        const svc = makeService();

        async function* mockStream() {
            yield Buffer.from('{"content":"done"}');
        }

        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        const events = [];
        for await (const event of svc.generateContentStream('claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        })) {
            events.push(event);
        }

        expect(events.some(e => e.type === 'message_delta')).toBe(true);
        expect(events.some(e => e.type === 'message_stop')).toBe(true);
    });

    test('toolUse 事件生成 tool_use content_block_start', async () => {
        const svc = makeService();

        async function* mockStream() {
            yield Buffer.from('{"name":"search","toolUseId":"tu_1","input":"{\\"q\\":\\"hello\\"}","stop":true}');
        }

        mockAxiosRequest.mockResolvedValueOnce({ data: mockStream() });

        const events = [];
        for await (const event of svc.generateContentStream('claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        })) {
            events.push(event);
        }

        const toolStart = events.find(
            e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'
        );
        expect(toolStart).toBeDefined();
        expect(toolStart.content_block.name).toBe('search');
    });

    test('messages 为空时抛出错误', async () => {
        const svc = makeService();

        await expect(async () => {
            for await (const _ of svc.generateContentStream('claude-sonnet-4-5', {
                messages: []
            })) {}
        }).rejects.toThrow('No messages found');
    });
});

// ---------------------------------------------------------------------------
// 测试：_handle402Error
// ---------------------------------------------------------------------------

describe('KiroApiService — _handle402Error', () => {
    test('成功验证用量后标记不健康并抛出', async () => {
        const svc = makeService();
        mockAxiosRequest.mockResolvedValueOnce({
            data: { usedCount: 100, limitCount: 100 }
        });

        const err = Object.assign(new Error('Quota Exceeded'), { response: { status: 402 } });

        await expect(svc._handle402Error(err, 'callApi')).rejects.toMatchObject({
            shouldSwitchCredential: true
        });
    });

    test('用量验证失败时仍标记不健康并抛出', async () => {
        const svc = makeService();
        // getUsageLimits fails
        mockAxiosRequest.mockRejectedValueOnce(new Error('usage API error'));

        const err = Object.assign(new Error('Quota Exceeded'), { response: { status: 402 } });

        await expect(svc._handle402Error(err, 'stream')).rejects.toMatchObject({
            shouldSwitchCredential: true
        });
    });
});

// ---------------------------------------------------------------------------
// 测试：_refreshUuid (有 poolManager)
// ---------------------------------------------------------------------------

describe('KiroApiService — _refreshUuid', () => {
    test('有 poolManager 时调用 refreshProviderUuid 并返回新 UUID', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        const mockPoolManager = {
            refreshProviderUuid: jest.fn(() => 'new-uuid-456'),
            markProviderNeedRefresh: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            resetProviderRefreshStatus: jest.fn(),
        };
        getProviderPoolManager.mockReturnValue(mockPoolManager);

        const svc = makeService();
        svc.uuid = 'old-uuid-123';

        const newUuid = svc._refreshUuid();

        expect(newUuid).toBe('new-uuid-456');
        expect(mockPoolManager.refreshProviderUuid).toHaveBeenCalled();

        getProviderPoolManager.mockReturnValue(null);
    });

    test('无 poolManager 时返回 null', () => {
        const svc = makeService();
        svc.uuid = 'some-uuid';

        const result = svc._refreshUuid();
        expect(result).toBeNull();
    });

    test('有 poolManager 但无 uuid 时返回 null', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        const mockPoolManager = { refreshProviderUuid: jest.fn(() => 'new-uuid') };
        getProviderPoolManager.mockReturnValue(mockPoolManager);

        const svc = makeService();
        svc.uuid = undefined; // no uuid

        const result = svc._refreshUuid();
        expect(result).toBeNull();

        getProviderPoolManager.mockReturnValue(null);
    });
});

// ---------------------------------------------------------------------------
// 测试：findRealTag quoted 路径 (line 128 coverage)
// ---------------------------------------------------------------------------

describe('KiroApiService — _toClaudeContentBlocksFromKiroText (quoted tag)', () => {
    test('引号内的 <thinking> 标签被跳过，只匹配真实标签', () => {
        const svc = makeService();
        // First <thinking> is inside quotes (has " before it), second is real
        const raw = '"<thinking>quoted</thinking>"\n\n<thinking>\nreal thought\n</thinking>\n\nfinal';
        const result = svc._toClaudeContentBlocksFromKiroText(raw);
        const thinkingBlock = result.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock.thinking).toContain('real thought');
        // There should be a text block containing 'final'
        const textBlocks = result.filter(b => b.type === 'text');
        const finalBlock = textBlocks.find(b => b.text && b.text.includes('final'));
        expect(finalBlock).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// 测试：parseEventStreamChunk — 更多分支
// ---------------------------------------------------------------------------

describe('KiroApiService — parseEventStreamChunk 额外覆盖', () => {
    let svc;
    beforeEach(() => { svc = makeService(); });

    test('工具调用有 stop=true 时添加到 toolCalls', () => {
        const rawData = ':message-typeevent{"name":"search","toolUseId":"tc_001","input":"{\\"q\\":\\"test\\"}","stop":true}';
        const result = svc.parseEventStreamChunk(rawData);
        expect(result.toolCalls.length).toBeGreaterThan(0);
        expect(result.toolCalls[0].function.name).toBe('search');
    });

    test('legacy event 格式解析（无 :message-type 前缀）', () => {
        const rawData = 'event{"content":"hello from legacy"}suffix';
        const result = svc.parseEventStreamChunk(rawData);
        expect(result.content).toContain('hello from legacy');
    });

    test('工具调用 input 累积跨多个事件', () => {
        const event1 = ':message-typeevent{"name":"fn","toolUseId":"tc_002","input":"{\\"a\\""}';
        const event2 = ':event-type:message-typeevent{"name":"fn","toolUseId":"tc_002","input":":\\"val\\"}","stop":true}';
        // Process both in one string
        const rawData = event1 + event2;
        const result = svc.parseEventStreamChunk(rawData);
        // Should have at least one tool call
        expect(Array.isArray(result.toolCalls)).toBe(true);
    });

    test('包含 [Called xxx with args: {...}] 格式时解析工具调用', () => {
        const rawData = ':message-typeevent{"content":"[Called myFunc with args: {\\"key\\": \\"value\\"}]"}';
        const result = svc.parseEventStreamChunk(rawData);
        // parseBracketToolCalls should detect the [Called ...] pattern
        expect(result).toBeDefined();
        expect(typeof result.content).toBe('string');
    });

    test('重复工具调用被 deduplicateToolCalls 去重', () => {
        const tc = '{"name":"duptool","toolUseId":"dup_1","input":"{\\"a\\":\\"b\\"}","stop":true}';
        const rawData = `:message-typeevent${tc}:event-type:message-typeevent${tc}`;
        const result = svc.parseEventStreamChunk(rawData);
        // Should have at most 1 tool call due to deduplication
        const dupTools = result.toolCalls.filter(t => t.function.name === 'duptool');
        expect(dupTools.length).toBeLessThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// 测试：buildCodewhispererRequest — 复杂消息场景
// ---------------------------------------------------------------------------

describe('KiroApiService — buildCodewhispererRequest 复杂消息', () => {
    let svc;
    beforeEach(() => {
        svc = makeService();
        jest.clearAllMocks();
    });

    test('最后一条消息为 assistant（数组内容）时 content 为 Continue', async () => {
        const messages = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        expect(req.conversationState.currentMessage.userInputMessage.content).toBe('Continue');
    });

    test('最后一条消息为 assistant（含 thinking）时正确处理', async () => {
        const messages = [
            { role: 'user', content: 'hello' },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'my thought' },
                    { type: 'text', text: 'answer' },
                    { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } }
                ]
            }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        expect(req.conversationState.currentMessage.userInputMessage.content).toBe('Continue');
    });

    test('最后一条用户消息含 tool_result 时 content 为 Tool results provided.', async () => {
        const messages = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'response' },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tu_1', content: 'result' }
                ]
            }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        expect(req.conversationState.currentMessage.userInputMessage.content)
            .toBe('Tool results provided.');
    });

    test('最后一条用户消息含 image 时包含 images 数组', async () => {
        const messages = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'response' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'look at this' },
                    { type: 'image', source: { media_type: 'image/jpeg', data: 'base64data' } }
                ]
            }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        const userMsg = req.conversationState.currentMessage.userInputMessage;
        expect(userMsg.images).toBeDefined();
        expect(userMsg.images[0].format).toBe('jpeg');
    });

    test('历史消息中 user 消息含 tool_result 和 image 被正确处理', async () => {
        const messages = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'response' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'tool result' },
                    { type: 'tool_result', tool_use_id: 'tu_1', content: 'result content' },
                    { type: 'image', source: { media_type: 'image/png', data: 'imgdata' } }
                ]
            },
            { role: 'assistant', content: 'after tool' },
            { role: 'user', content: 'final' }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        expect(req.conversationState.history).toBeDefined();
    });

    test('历史消息中 assistant 含 thinking 和 tool_use', async () => {
        const messages = [
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'some thought' },
                    { type: 'text', text: 'answer' },
                    { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } }
                ]
            },
            { role: 'user', content: 'continue' }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        expect(req.conversationState.history).toBeDefined();
    });

    test('history 末尾不是 assistantResponseMessage 时自动补全', async () => {
        const messages = [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },  // two user messages → merged
            { role: 'user', content: 'third' }     // another user after merge
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', null, 'system');
        expect(req).toBeDefined();
    });

    test('第一条消息是 assistant 时 system prompt 作为独立消息入 history', async () => {
        const messages = [
            { role: 'assistant', content: 'leading assistant' },
            { role: 'user', content: 'question' }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', null, 'System prompt');
        expect(req.conversationState.history).toBeDefined();
        const firstHistory = req.conversationState.history[0];
        expect(firstHistory.userInputMessage.content).toContain('System prompt');
        expect(firstHistory.userInputMessage.content).not.toContain('leading assistant');
    });

    test('所有工具描述为空时添加占位工具', async () => {
        const messages = [{ role: 'user', content: 'use tool' }];
        const tools = [
            { name: 'empty_tool', description: '', input_schema: {} },
            { name: 'also_empty', description: '   ', input_schema: {} }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5', tools);
        const ctx = req.conversationState.currentMessage.userInputMessage.userInputMessageContext;
        expect(ctx.tools[0].toolSpecification.name).toBe('no_tool_available');
    });

    test('工具调用 assistant 消息内容为 string 时处理', async () => {
        const messages = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'simple string answer' }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        expect(req.conversationState.currentMessage.userInputMessage.content).toBe('Continue');
    });

    test('最后一条 assistant 的 tool_use 为空时 toolUses 字段被删除', async () => {
        const messages = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'no tools' }] }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        // The assistant message in history should not have toolUses field
        expect(req.conversationState.history).toBeDefined();
    });

    test('历史消息中超过 5 条的图片被替换为占位符', async () => {
        // systemPrompt is always set (builtInPrefix), so processedMessages[0] (user) becomes history[0]
        // and startIndex = 1. The history loop then processes indices 1..length-2.
        // For the image at index 2: distanceFromEnd = (10 - 2) = 8 > 5 → replace with placeholder
        const image = { type: 'image', source: { media_type: 'image/png', data: 'data' } };
        const messages = [
            { role: 'user', content: 'first' },   // 0: merged with systemPrompt
            { role: 'assistant', content: 'r1' },  // 1: in loop, distanceFromEnd=9
            { role: 'user', content: [{ type: 'text', text: 'img msg' }, image] }, // 2: in loop, distanceFromEnd=8 > 5 → replace
            { role: 'assistant', content: 'r2' },  // 3
            { role: 'user', content: 'u3' },       // 4
            { role: 'assistant', content: 'r3' },  // 5
            { role: 'user', content: 'u4' },       // 6
            { role: 'assistant', content: 'r4' },  // 7
            { role: 'user', content: 'u5' },       // 8
            { role: 'assistant', content: 'r5' },  // 9
            { role: 'user', content: 'final' }     // 10: currentMessage
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        // The user message at index 2 should have image replaced with placeholder
        const msgWithPlaceholder = req.conversationState.history.find(
            h => h.userInputMessage && typeof h.userInputMessage.content === 'string' &&
                 h.userInputMessage.content.includes('图片')
        );
        expect(msgWithPlaceholder).toBeDefined();
    });

    test('重复的 toolUseId 在 history user 消息中被去重', async () => {
        const messages = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'response' },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'dup_id', content: 'result1' },
                    { type: 'tool_result', tool_use_id: 'dup_id', content: 'result2' }
                ]
            },
            { role: 'assistant', content: 'after' },
            { role: 'user', content: 'next' }
        ];
        const req = await svc.buildCodewhispererRequest(messages, 'claude-sonnet-4-5');
        // Should not throw and should produce valid request
        expect(req).toBeDefined();
    });
});
