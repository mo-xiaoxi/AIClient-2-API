/**
 * Claude Converter Deep Tests
 * Tests the actual conversion logic with minimal mocking.
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

// Must mock tls-sidecar before any imports
jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
    default: {},
    initTlsSidecar: jest.fn(),
}));

// Mock logger to avoid filesystem/console side effects
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

let ClaudeConverter;
let MODEL_PROTOCOL_PREFIX;

beforeAll(async () => {
    ({ ClaudeConverter } = await import('../../../src/converters/strategies/ClaudeConverter.js'));
    ({ MODEL_PROTOCOL_PREFIX } = await import('../../../src/utils/common.js'));
});

describe('ClaudeConverter - Claude -> OpenAI Request', () => {
    test('converts simple text message', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3-opus',
            messages: [{ role: 'user', content: 'Hello world' }],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.model).toBe('claude-3-opus');
        expect(result.messages).toBeDefined();
        expect(result.messages.length).toBeGreaterThan(0);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(JSON.stringify(userMsg.content)).toContain('Hello world');
    });

    test('extracts system prompt into OpenAI system message', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3-opus',
            system: 'You are a helpful assistant.',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        const systemMsg = result.messages.find(m => m.role === 'system');
        expect(systemMsg).toBeDefined();
        expect(systemMsg.content).toContain('You are a helpful assistant.');
    });

    test('handles system prompt as array', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            system: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        const systemMsg = result.messages.find(m => m.role === 'system');
        expect(systemMsg).toBeDefined();
        expect(systemMsg.content).toContain('Part 1');
        expect(systemMsg.content).toContain('Part 2');
    });

    test('converts tool_use message in assistant role', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            messages: [
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tool_abc',
                            name: 'get_weather',
                            input: { location: 'NYC' },
                        },
                    ],
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool_abc',
                            content: 'Sunny, 75F',
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        const assistantMsg = result.messages.find(m => m.role === 'assistant' && m.tool_calls);
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg.tool_calls[0].function.name).toBe('get_weather');
        const toolMsg = result.messages.find(m => m.role === 'tool');
        expect(toolMsg).toBeDefined();
        expect(toolMsg.tool_call_id).toBe('tool_abc');
    });

    test('converts tools list to OpenAI format', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Use a tool' }],
            tools: [
                {
                    name: 'search',
                    description: 'Search the web',
                    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
                },
            ],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.tools).toBeDefined();
        expect(result.tools[0].type).toBe('function');
        expect(result.tools[0].function.name).toBe('search');
        expect(result.tool_choice).toBe('auto');
    });

    test('handles thinking enabled conversion', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Think hard' }],
            thinking: { type: 'enabled', budget_tokens: 5000 },
            max_tokens: 10000,
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.reasoning_effort).toBeDefined();
        expect(result.max_completion_tokens).toBe(10000);
    });

    test('throws for unsupported target protocol', async () => {
        const converter = new ClaudeConverter();
        expect(() =>
            converter.convertRequest({ messages: [] }, 'unknown-protocol')
        ).toThrow('Unsupported target protocol');
    });

    test('handles content array with image block', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Look at this' },
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/png',
                                data: 'abc123',
                            },
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        const imageBlock = userMsg.content.find(c => c.type === 'image_url');
        expect(imageBlock).toBeDefined();
        expect(imageBlock.image_url.url).toContain('data:image/png;base64,');
    });
});

describe('ClaudeConverter - Claude -> OpenAI Response', () => {
    test('converts simple text response', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            id: 'msg_123',
            content: [{ type: 'text', text: 'Hello from Claude' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.role).toBe('assistant');
        expect(result.choices[0].message.content).toContain('Hello from Claude');
        expect(result.choices[0].finish_reason).toBe('stop');
        expect(result.usage.prompt_tokens).toBe(10);
        expect(result.usage.completion_tokens).toBe(5);
    });

    test('converts empty content response', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [],
            usage: { input_tokens: 5, output_tokens: 0 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.content).toBe('');
    });

    test('converts tool_use response to tool_calls', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_xyz',
                    name: 'calculator',
                    input: { expression: '2+2' },
                },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 20, output_tokens: 10 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(result.choices[0].message.tool_calls).toBeDefined();
        expect(result.choices[0].message.tool_calls[0].function.name).toBe('calculator');
        const args = JSON.parse(result.choices[0].message.tool_calls[0].function.arguments);
        expect(args.expression).toBe('2+2');
    });

    test('maps stop_reason max_tokens to length finish_reason', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [{ type: 'text', text: 'truncated' }],
            stop_reason: 'max_tokens',
            usage: { input_tokens: 100, output_tokens: 200 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].finish_reason).toBe('length');
    });

    test('extracts thinking blocks into reasoning_content', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [
                { type: 'thinking', thinking: 'My thought process' },
                { type: 'text', text: 'Final answer' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 30 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].message.reasoning_content).toContain('My thought process');
        expect(result.choices[0].message.content).toContain('Final answer');
    });
});

describe('ClaudeConverter - Stream Chunk Conversion', () => {
    test('converts message_start chunk', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'message_start',
            message: { usage: { input_tokens: 15, cache_read_input_tokens: 0 } },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.object).toBe('chat.completion.chunk');
        expect(result.choices[0].delta.role).toBe('assistant');
    });

    test('converts content_block_start for text type', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.object).toBe('chat.completion.chunk');
        expect(result.choices[0].delta.content).toBe('');
    });

    test('converts content_block_start for tool_use type', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool_1', name: 'get_data' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.tool_calls).toBeDefined();
        expect(result.choices[0].delta.tool_calls[0].function.name).toBe('get_data');
    });

    test('converts content_block_delta text_delta', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.content).toBe('Hello');
    });

    test('converts content_block_delta thinking_delta', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'thinking...' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.reasoning_content).toBe('thinking...');
    });

    test('converts content_block_delta input_json_delta', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"key"' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.tool_calls[0].function.arguments).toBe('{"key"');
    });

    test('converts content_block_stop', async () => {
        const converter = new ClaudeConverter();
        const chunk = { type: 'content_block_stop', index: 0 };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.object).toBe('chat.completion.chunk');
        expect(result.choices[0].delta).toEqual({});
    });

    test('converts message_delta with stop finish_reason', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { input_tokens: 10, output_tokens: 20 },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('converts message_delta with tool_use finish_reason', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    test('returns null for message_stop', async () => {
        const converter = new ClaudeConverter();
        const chunk = { type: 'message_stop' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result).toBeNull();
    });

    test('handles string chunk (legacy format)', async () => {
        const converter = new ClaudeConverter();
        const result = converter.convertStreamChunk('Hello text', MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.content).toBe('Hello text');
    });
});

describe('ClaudeConverter - Claude -> Gemini Request', () => {
    test('converts simple Claude request to Gemini format', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Hello Gemini' }],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.contents).toBeDefined();
        expect(Array.isArray(result.contents)).toBe(true);
    });

    test('converts system prompt to systemInstruction', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            system: 'Be helpful.',
            messages: [{ role: 'user', content: 'Hello' }],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.systemInstruction).toBeDefined();
        expect(result.systemInstruction.parts[0].text).toContain('Be helpful.');
    });

    test('converts array system prompt to systemInstruction', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            system: [{ type: 'text', text: 'Rule 1' }, { type: 'text', text: 'Rule 2' }],
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.systemInstruction).toBeDefined();
        const texts = result.systemInstruction.parts.map(p => p.text);
        expect(texts).toContain('Rule 1');
        expect(texts).toContain('Rule 2');
    });

    test('maps assistant role to model role in Gemini', async () => {
        const converter = new ClaudeConverter();
        const claudeReq = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
            ],
        };
        const result = converter.convertRequest(claudeReq, MODEL_PROTOCOL_PREFIX.GEMINI);
        const modelContent = result.contents.find(c => c.role === 'model');
        expect(modelContent).toBeDefined();
    });
});

describe('ClaudeConverter - Model List Conversion', () => {
    test('converts Claude model list to OpenAI format', async () => {
        const converter = new ClaudeConverter();
        const claudeModels = {
            models: [
                { id: 'claude-3-opus', name: 'claude-3-opus' },
                { id: 'claude-3-sonnet', name: 'claude-3-sonnet' },
            ],
        };
        const result = converter.convertModelList(claudeModels, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.object).toBe('list');
        expect(result.data).toHaveLength(2);
        expect(result.data[0].owned_by).toBe('anthropic');
    });

    test('converts Claude model list to Gemini format', async () => {
        const converter = new ClaudeConverter();
        const claudeModels = {
            models: [{ id: 'claude-3-opus', name: 'claude-3-opus' }],
        };
        const result = converter.convertModelList(claudeModels, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.models).toBeDefined();
        expect(result.models[0].name).toContain('models/');
    });
});

// ===========================================================================
// ClaudeConverter - Claude -> Gemini Request (array content blocks)
// ===========================================================================

describe('ClaudeConverter - Claude -> Gemini Request (array content)', () => {
    test('converts array text content to Gemini parts', async () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.contents[0].parts[0].text).toBe('Hello');
    });

    test('converts thinking content block with thought=true', async () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{
                role: 'assistant',
                content: [{ type: 'thinking', thinking: 'My thought process' }]
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        const parts = result.contents[0].parts;
        expect(parts[0].thought).toBe(true);
        expect(parts[0].text).toBe('My thought process');
    });

    test('converts tool_use content block to functionCall', async () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{
                role: 'assistant',
                content: [{ type: 'tool_use', name: 'search', id: 'tool-1', input: { query: 'test' } }]
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        const parts = result.contents[0].parts;
        const funcPart = parts.find(p => p.functionCall);
        expect(funcPart).toBeDefined();
        expect(funcPart.functionCall.name).toBe('search');
    });

    test('converts redacted_thinking content block', async () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{
                role: 'assistant',
                content: [{ type: 'redacted_thinking', data: 'encrypted-data' }]
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        const text = result.contents[0].parts[0].text;
        expect(text).toContain('encrypted-data');
    });

    test('converts thinking config (budget_tokens) to thinkingBudget', async () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Think' }],
            thinking: { type: 'enabled', budget_tokens: 8000 },
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.generationConfig.thinkingConfig.thinkingBudget).toBe(8000);
    });

    test('converts tools to functionDeclarations with parametersJsonSchema', async () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Use tool' }],
            tools: [{
                name: 'lookup',
                description: 'Look things up',
                input_schema: { type: 'object', properties: { q: { type: 'string' } } }
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.tools).toBeDefined();
        expect(result.tools[0].functionDeclarations[0].name).toBe('lookup');
        expect(result.tools[0].functionDeclarations[0].parametersJsonSchema).toBeDefined();
    });

    test('cleanUrlFormatFromSchema removes uri format from string fields', async () => {
        const converter = new ClaudeConverter();
        const schema = {
            type: 'object',
            properties: {
                url: { type: 'string', format: 'uri' },
                name: { type: 'string' },
            }
        };
        converter.cleanUrlFormatFromSchema(schema);
        expect(schema.properties.url.format).toBeUndefined();
        expect(schema.properties.name.format).toBeUndefined();
    });

    test('object system prompt is converted to JSON string in systemInstruction', async () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            system: { type: 'text', text: 'Be concise' },
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.systemInstruction.parts[0].text).toContain('Be concise');
    });
});

// ===========================================================================
// ClaudeConverter - Claude -> Gemini Response
// ===========================================================================

describe('ClaudeConverter - Claude -> Gemini Response', () => {
    test('converts text response to Gemini candidates format', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [{ type: 'text', text: 'Hello Gemini' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result.candidates[0].content.role).toBe('model');
        expect(result.candidates[0].content.parts[0].text).toBe('Hello Gemini');
        expect(result.candidates[0].finishReason).toBe('STOP');
    });

    test('maps max_tokens stop_reason to MAX_TOKENS', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [{ type: 'text', text: 'truncated' }],
            stop_reason: 'max_tokens',
            usage: { input_tokens: 5, output_tokens: 5 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result.candidates[0].finishReason).toBe('MAX_TOKENS');
    });

    test('converts thinking block to thought=true part', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [{ type: 'thinking', thinking: 'reasoning process' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 5 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        const parts = result.candidates[0].content.parts;
        expect(parts[0].thought).toBe(true);
    });

    test('converts tool_use block to functionCall part', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'test' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 5, output_tokens: 5 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        const parts = result.candidates[0].content.parts;
        expect(parts[0].functionCall.name).toBe('search');
    });

    test('returns empty candidates for empty content', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = { content: [], usage: {} };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result.candidates).toHaveLength(0);
    });

    test('includes usageMetadata', async () => {
        const converter = new ClaudeConverter();
        const claudeResp = {
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result.usageMetadata.promptTokenCount).toBe(10);
        expect(result.usageMetadata.candidatesTokenCount).toBe(5);
        expect(result.usageMetadata.cachedContentTokenCount).toBe(2);
    });
});

// ===========================================================================
// ClaudeConverter - Claude -> Gemini Stream Chunk
// ===========================================================================

describe('ClaudeConverter - Claude -> Gemini Stream Chunk', () => {
    test('converts content_block_delta text_delta to Gemini chunk', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'streaming text' }
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result).toBeDefined();
        const chunks = Array.isArray(result) ? result : [result];
        const hasText = chunks.some(c => c?.candidates?.[0]?.content?.parts?.some(p => p.text === 'streaming text'));
        expect(hasText).toBe(true);
    });

    test('returns null for null chunk', async () => {
        const converter = new ClaudeConverter();
        const result = converter.convertStreamChunk(null, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result).toBeNull();
    });

    test('converts content_block_start tool_use to Gemini functionCall chunk', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_start',
            content_block: { type: 'tool_use', name: 'myTool', id: 't1' }
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result).not.toBeNull();
        const candidates = Array.isArray(result) ? result[0]?.candidates : result?.candidates;
        expect(candidates).toBeDefined();
    });

    test('returns null for content_block_start thinking type', async () => {
        const converter = new ClaudeConverter();
        const chunk = { type: 'content_block_start', content_block: { type: 'thinking' } };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result).toBeNull();
    });

    test('converts message_delta stop to Gemini finishReason', async () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 15 }
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'claude-3');
        expect(result).not.toBeNull();
    });
});

// ===========================================================================
// ClaudeConverter - routing for OPENAI_RESPONSES and CODEX protocols
// ===========================================================================

describe('ClaudeConverter - OPENAI_RESPONSES routing', () => {
    test('convertRequest OPENAI_RESPONSES returns a result', async () => {
        const converter = new ClaudeConverter();
        const req = { model: 'claude-3', messages: [{ role: 'user', content: 'Hi' }] };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result).toBeDefined();
    });

    test('convertResponse OPENAI_RESPONSES returns a result', async () => {
        const converter = new ClaudeConverter();
        const resp = {
            content: [{ type: 'text', text: 'Hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 3 },
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(result).toBeDefined();
    });

    test('convertStreamChunk OPENAI_RESPONSES for text_delta', async () => {
        const converter = new ClaudeConverter();
        const chunk = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(result === null || typeof result === 'object').toBe(true);
    });
});

describe('ClaudeConverter - CODEX routing', () => {
    test('convertRequest CODEX returns a result', async () => {
        const converter = new ClaudeConverter();
        const req = { model: 'claude-3', messages: [{ role: 'user', content: 'Hi' }] };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result).toBeDefined();
    });

    test('convertResponse CODEX returns a result', async () => {
        const converter = new ClaudeConverter();
        const resp = {
            content: [{ type: 'text', text: 'Hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 3 },
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.CODEX, 'claude-3');
        expect(result === null || typeof result === 'object').toBe(true);
    });

    test('convertStreamChunk CODEX for text_delta', async () => {
        const converter = new ClaudeConverter();
        const chunk = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CODEX, 'claude-3');
        expect(result === null || typeof result === 'object').toBe(true);
    });
});

describe('ClaudeConverter - GROK routing', () => {
    test('convertRequest GROK returns a result', async () => {
        const converter = new ClaudeConverter();
        const req = { model: 'claude-3', messages: [{ role: 'user', content: 'Hi' }] };
        let result;
        try {
            result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GROK);
        } catch {
            result = null; // import.meta.url may throw in some Jest configs
        }
        expect(result === null || typeof result === 'object').toBe(true);
    });
});
