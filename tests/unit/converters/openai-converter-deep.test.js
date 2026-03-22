/**
 * OpenAI Converter Deep Tests
 * Tests the actual conversion logic with minimal mocking.
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
    default: {},
    initTlsSidecar: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

let OpenAIConverter;
let MODEL_PROTOCOL_PREFIX;

beforeAll(async () => {
    ({ OpenAIConverter } = await import('../../../src/converters/strategies/OpenAIConverter.js'));
    ({ MODEL_PROTOCOL_PREFIX } = await import('../../../src/utils/common.js'));
});

describe('OpenAIConverter - OpenAI -> Claude Request', () => {
    test('converts simple user message to Claude format', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3-opus',
            messages: [{ role: 'user', content: 'Hello Claude' }],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.messages).toBeDefined();
        expect(result.messages[0].role).toBe('user');
        const textBlock = result.messages[0].content.find(c => c.type === 'text');
        expect(textBlock.text).toContain('Hello Claude');
    });

    test('extracts system message into Claude system field', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3-opus',
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hi' },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.system).toContain('You are helpful.');
        // system messages should not be in messages array
        const sysMsg = result.messages.find(m => m.role === 'system');
        expect(sysMsg).toBeUndefined();
    });

    test('converts tool message to tool_result in Claude format', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: 'Use tool' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
                        },
                    ],
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_1',
                    content: 'Sunny, 75F',
                },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        const toolResultMsg = result.messages.find(
            m => m.role === 'user' && m.content.some(c => c.type === 'tool_result')
        );
        expect(toolResultMsg).toBeDefined();
        const toolResult = toolResultMsg.content.find(c => c.type === 'tool_result');
        expect(toolResult.tool_use_id).toBe('call_1');
        expect(toolResult.content).toBe('Sunny, 75F');
    });

    test('converts assistant tool_calls to Claude tool_use format', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3',
            messages: [
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            id: 'call_abc',
                            type: 'function',
                            function: {
                                name: 'calculator',
                                arguments: '{"expr": "2+2"}',
                            },
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        const assistantMsg = result.messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        const toolUse = assistantMsg.content.find(c => c.type === 'tool_use');
        expect(toolUse).toBeDefined();
        expect(toolUse.name).toBe('calculator');
        expect(toolUse.input.expr).toBe('2+2');
    });

    test('converts image_url content to Claude image format (base64)', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Look at this image' },
                        {
                            type: 'image_url',
                            image_url: { url: 'data:image/png;base64,abc123' },
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        const imageBlock = userMsg.content.find(c => c.type === 'image');
        expect(imageBlock).toBeDefined();
        expect(imageBlock.source.type).toBe('base64');
        expect(imageBlock.source.media_type).toBe('image/png');
    });

    test('converts image_url with URL-only to text description', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: 'https://example.com/image.jpg' },
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        const userMsg = result.messages.find(m => m.role === 'user');
        const textBlock = userMsg.content.find(c => c.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock.text).toContain('Image:');
    });

    test('converts OpenAI tools to Claude tools format', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Do something' }],
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'get_data',
                        description: 'Fetch data',
                        parameters: { type: 'object', properties: {} },
                    },
                },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.tools).toBeDefined();
        expect(result.tools[0].name).toBe('get_data');
        expect(result.tools[0].input_schema).toBeDefined();
    });

    test('merges adjacent same-role messages', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: 'First message' },
                { role: 'user', content: 'Second message' },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        const userMsgs = result.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        expect(userMsgs[0].content.length).toBe(2);
    });

    test('handles extra_body anthropic thinking enabled', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Think' }],
            extra_body: {
                anthropic: {
                    thinking: { type: 'enabled', budget_tokens: 2000 },
                },
            },
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.thinking).toBeDefined();
        expect(result.thinking.type).toBe('enabled');
        expect(result.thinking.budget_tokens).toBe(2000);
    });

    test('throws for unsupported target protocol', async () => {
        const converter = new OpenAIConverter();
        expect(() =>
            converter.convertRequest({ messages: [] }, 'bad-protocol')
        ).toThrow('Unsupported target protocol');
    });
});

describe('OpenAIConverter - OpenAI -> Claude Response', () => {
    test('converts simple text response to Claude format', async () => {
        const converter = new OpenAIConverter();
        const openaiResp = {
            id: 'chatcmpl-123',
            choices: [
                {
                    message: { role: 'assistant', content: 'Hello there!' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
        const result = converter.convertResponse(openaiResp, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        expect(result.type).toBe('message');
        expect(result.role).toBe('assistant');
        expect(result.stop_reason).toBe('end_turn');
        const textBlock = result.content.find(c => c.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock.text).toContain('Hello there!');
    });

    test('converts tool_calls response to Claude tool_use format', async () => {
        const converter = new OpenAIConverter();
        const openaiResp = {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'search', arguments: '{"query":"test"}' },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
        };
        const result = converter.convertResponse(openaiResp, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        const toolUse = result.content.find(c => c.type === 'tool_use');
        expect(toolUse).toBeDefined();
        expect(toolUse.name).toBe('search');
        expect(toolUse.input.query).toBe('test');
    });

    test('converts reasoning_content to thinking block', async () => {
        const converter = new OpenAIConverter();
        const openaiResp = {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: 'Final answer',
                        reasoning_content: 'My reasoning here',
                    },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
        };
        const result = converter.convertResponse(openaiResp, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        const thinkingBlock = result.content.find(c => c.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock.thinking).toContain('My reasoning here');
    });

    test('handles empty choices', async () => {
        const converter = new OpenAIConverter();
        const openaiResp = {
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 0 },
        };
        const result = converter.convertResponse(openaiResp, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        expect(result.type).toBe('message');
        expect(result.content).toEqual([]);
    });
});

describe('OpenAIConverter - OpenAI -> Claude Stream Chunk', () => {
    test('converts text content delta to Claude text_delta', async () => {
        const converter = new OpenAIConverter();
        const chunk = {
            id: 'chatcmpl-1',
            choices: [
                {
                    delta: { content: 'Hello' },
                    finish_reason: null,
                },
            ],
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        expect(Array.isArray(result)).toBe(true);
        const textDelta = result.find(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta');
        expect(textDelta).toBeDefined();
        expect(textDelta.delta.text).toBe('Hello');
    });

    test('converts reasoning_content to thinking_delta', async () => {
        const converter = new OpenAIConverter();
        const chunk = {
            id: 'chatcmpl-1',
            choices: [
                {
                    delta: { reasoning_content: 'Thinking...' },
                    finish_reason: null,
                },
            ],
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        expect(Array.isArray(result)).toBe(true);
        const thinkingDelta = result.find(
            e => e.type === 'content_block_delta' && e.delta.type === 'thinking_delta'
        );
        expect(thinkingDelta).toBeDefined();
        expect(thinkingDelta.delta.thinking).toBe('Thinking...');
    });

    test('converts finish_reason stop to Claude message_delta + message_stop', async () => {
        const converter = new OpenAIConverter();
        const chunk = {
            id: 'chatcmpl-1',
            choices: [
                {
                    delta: {},
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        expect(Array.isArray(result)).toBe(true);
        const messageDelta = result.find(e => e.type === 'message_delta');
        expect(messageDelta).toBeDefined();
        expect(messageDelta.delta.stop_reason).toBe('end_turn');
        const messageStop = result.find(e => e.type === 'message_stop');
        expect(messageStop).toBeDefined();
    });

    test('converts finish_reason length to max_tokens', async () => {
        const converter = new OpenAIConverter();
        const chunk = {
            id: 'chatcmpl-1',
            choices: [{ delta: {}, finish_reason: 'length' }],
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        const messageDelta = result.find(e => e.type === 'message_delta');
        expect(messageDelta.delta.stop_reason).toBe('max_tokens');
    });

    test('returns null for chunk with no choices', async () => {
        const converter = new OpenAIConverter();
        const chunk = { choices: [] };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        expect(result).toBeNull();
    });

    test('handles string chunk (legacy format)', async () => {
        const converter = new OpenAIConverter();
        const result = converter.convertStreamChunk('text chunk', MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3');
        expect(result.type).toBe('content_block_delta');
        expect(result.delta.type).toBe('text_delta');
        expect(result.delta.text).toBe('text chunk');
    });
});

describe('OpenAIConverter - OpenAI -> Gemini Request', () => {
    test('converts simple OpenAI request to Gemini format', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'gemini-pro',
            messages: [{ role: 'user', content: 'Hello Gemini' }],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.contents).toBeDefined();
        expect(Array.isArray(result.contents)).toBe(true);
        expect(result.contents[0].role).toBe('user');
    });

    test('converts system message to system_instruction', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'gemini-pro',
            messages: [
                { role: 'system', content: 'Be a helpful assistant.' },
                { role: 'user', content: 'Hi' },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.GEMINI);
        // The OpenAIConverter uses system_instruction (snake_case) for Gemini target
        expect(result.system_instruction).toBeDefined();
        expect(result.system_instruction.parts[0].text).toContain('Be a helpful assistant.');
    });

    test('converts tool response messages to functionResponse', async () => {
        const converter = new OpenAIConverter();
        const openaiReq = {
            model: 'gemini-pro',
            messages: [
                { role: 'user', content: 'Call tool' },
                {
                    role: 'assistant',
                    tool_calls: [
                        {
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'myFunc', arguments: '{}' },
                        },
                    ],
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_1',
                    content: 'result data',
                },
            ],
        };
        const result = converter.convertRequest(openaiReq, MODEL_PROTOCOL_PREFIX.GEMINI);
        // Should have a functionResponse in the contents
        const funcResponseContent = result.contents.find(
            c => c.parts && c.parts.some(p => p.functionResponse)
        );
        expect(funcResponseContent).toBeDefined();
    });
});

describe('OpenAIConverter - Model List Conversion', () => {
    test('converts OpenAI model list to Claude format', async () => {
        const converter = new OpenAIConverter();
        const openaiModels = {
            data: [
                { id: 'gpt-4', object: 'model', owned_by: 'openai' },
                { id: 'gpt-3.5-turbo', object: 'model', owned_by: 'openai' },
            ],
        };
        const result = converter.convertModelList(openaiModels, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.models).toBeDefined();
        expect(result.models).toHaveLength(2);
        expect(result.models[0].name).toBe('gpt-4');
    });

    test('converts OpenAI model list to Gemini format', async () => {
        const converter = new OpenAIConverter();
        const openaiModels = {
            data: [{ id: 'gpt-4', object: 'model', owned_by: 'openai' }],
        };
        const result = converter.convertModelList(openaiModels, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.models).toBeDefined();
        expect(result.models[0].name).toBe('models/gpt-4');
    });

    test('adds display_name for passthrough model list', async () => {
        const converter = new OpenAIConverter();
        const openaiModels = {
            data: [{ id: 'custom-model', object: 'model' }],
        };
        const result = converter.convertModelList(openaiModels, 'openai');
        expect(result.data[0].display_name).toBe('custom-model');
    });

    test('builds Claude tool_choice from string auto', async () => {
        const converter = new OpenAIConverter();
        const result = converter.buildClaudeToolChoice('auto');
        expect(result.type).toBe('auto');
    });

    test('builds Claude tool_choice from string required', async () => {
        const converter = new OpenAIConverter();
        const result = converter.buildClaudeToolChoice('required');
        expect(result.type).toBe('any');
    });

    test('builds Claude tool_choice from object with function', async () => {
        const converter = new OpenAIConverter();
        const result = converter.buildClaudeToolChoice({ function: { name: 'myTool' } });
        expect(result.type).toBe('tool');
        expect(result.name).toBe('myTool');
    });
});
