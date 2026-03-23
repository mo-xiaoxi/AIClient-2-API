/**
 * provider-strategies.js 单元测试
 * 测试: ProviderStrategyFactory
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

let ProviderStrategyFactory;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        __esModule: true,
        MODEL_PROTOCOL_PREFIX: {
            GEMINI: 'gemini',
            OPENAI: 'openai',
            OPENAI_RESPONSES: 'openaiResponses',
            CLAUDE: 'claude',
            CODEX: 'codex',
            FORWARD: 'forward',
            GROK: 'grok',
        },
        FETCH_SYSTEM_PROMPT_FILE: '/tmp/test-system-prompt.txt',
    }));

    // Mock 所有 strategy 类
    await jest.unstable_mockModule('../../../src/providers/gemini/gemini-strategy.js', () => ({
        __esModule: true,
        GeminiStrategy: class MockGeminiStrategy { name = 'gemini'; },
    }));

    await jest.unstable_mockModule('../../../src/providers/openai/openai-strategy.js', () => ({
        __esModule: true,
        OpenAIStrategy: class MockOpenAIStrategy { name = 'openai'; },
    }));

    await jest.unstable_mockModule('../../../src/providers/claude/claude-strategy.js', () => ({
        __esModule: true,
        ClaudeStrategy: class MockClaudeStrategy { name = 'claude'; },
    }));

    await jest.unstable_mockModule('../../../src/providers/openai/openai-responses-strategy.js', () => ({
        __esModule: true,
        ResponsesAPIStrategy: class MockResponsesAPIStrategy { name = 'openaiResponses'; },
    }));

    await jest.unstable_mockModule('../../../src/providers/openai/codex-responses-strategy.js', () => ({
        __esModule: true,
        CodexResponsesAPIStrategy: class MockCodexResponsesAPIStrategy { name = 'codex'; },
    }));

    await jest.unstable_mockModule('../../../src/providers/forward/forward-strategy.js', () => ({
        __esModule: true,
        ForwardStrategy: class MockForwardStrategy { name = 'forward'; },
    }));

    await jest.unstable_mockModule('../../../src/providers/grok/grok-strategy.js', () => ({
        __esModule: true,
        GrokStrategy: class MockGrokStrategy { name = 'grok'; },
    }));

    const mod = await import('../../../src/utils/provider-strategies.js');
    ProviderStrategyFactory = mod.ProviderStrategyFactory;
});

describe('ProviderStrategyFactory', () => {
    test('应返回 GeminiStrategy', () => {
        const strategy = ProviderStrategyFactory.getStrategy('gemini');
        expect(strategy.name).toBe('gemini');
    });

    test('应返回 OpenAIStrategy', () => {
        const strategy = ProviderStrategyFactory.getStrategy('openai');
        expect(strategy.name).toBe('openai');
    });

    test('应返回 ResponsesAPIStrategy', () => {
        const strategy = ProviderStrategyFactory.getStrategy('openaiResponses');
        expect(strategy.name).toBe('openaiResponses');
    });

    test('应返回 ClaudeStrategy', () => {
        const strategy = ProviderStrategyFactory.getStrategy('claude');
        expect(strategy.name).toBe('claude');
    });

    test('应返回 CodexResponsesAPIStrategy', () => {
        const strategy = ProviderStrategyFactory.getStrategy('codex');
        expect(strategy.name).toBe('codex');
    });

    test('应返回 ForwardStrategy', () => {
        const strategy = ProviderStrategyFactory.getStrategy('forward');
        expect(strategy.name).toBe('forward');
    });

    test('应返回 GrokStrategy', () => {
        const strategy = ProviderStrategyFactory.getStrategy('grok');
        expect(strategy.name).toBe('grok');
    });

    test('不支持的协议应抛出错误', () => {
        expect(() => ProviderStrategyFactory.getStrategy('unknown')).toThrow('Unsupported provider protocol');
    });

    test('每次调用应返回新实例', () => {
        const s1 = ProviderStrategyFactory.getStrategy('gemini');
        const s2 = ProviderStrategyFactory.getStrategy('gemini');
        expect(s1).not.toBe(s2);
    });
});
