/**
 * Extended tests for OpenAIConverter — covers conversions to Claude, Gemini,
 * model lists, stream chunks, and edge cases beyond the existing 2 tests.
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

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
let converter;

beforeAll(async () => {
    ({ OpenAIConverter } = await import('../../../src/converters/strategies/OpenAIConverter.js'));
    ({ MODEL_PROTOCOL_PREFIX } = await import('../../../src/utils/common.js'));
});

beforeEach(() => {
    converter = new OpenAIConverter();
});

// ============================================================================
// convertRequest routing
// ============================================================================

describe('OpenAIConverter.convertRequest routing', () => {
    test('throws for unknown target protocol', () => {
        expect(() => converter.convertRequest({ messages: [] }, 'unknown-proto')).toThrow(
            'Unsupported target protocol'
        );
    });

    test('claude target returns claude-shaped request', () => {
        const result = converter.convertRequest(
            { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] },
            MODEL_PROTOCOL_PREFIX.CLAUDE
        );
        expect(result).toHaveProperty('messages');
        expect(result).toHaveProperty('max_tokens');
    });

    test('gemini target returns gemini-shaped request', () => {
        const result = converter.convertRequest(
            { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] },
            MODEL_PROTOCOL_PREFIX.GEMINI
        );
        expect(result).toHaveProperty('contents');
    });

    test('openaiResponses target returns responses-shaped request', () => {
        const result = converter.convertRequest(
            { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] },
            MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES
        );
        expect(result).toHaveProperty('model');
    });
});

// ============================================================================
// OpenAI -> Claude request
// ============================================================================

describe('OpenAIConverter.toClaudeRequest', () => {
    test('user text message becomes text content block', () => {
        const req = {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hello' }],
        };
        const result = converter.toClaudeRequest(req);
        expect(result.messages[0].role).toBe('user');
        expect(Array.isArray(result.messages[0].content)).toBe(true);
        expect(result.messages[0].content[0].type).toBe('text');
        expect(result.messages[0].content[0].text).toBe('Hello');
    });

    test('system message becomes system field on Claude request', () => {
        const req = {
            model: 'gpt-4',
            messages: [
                { role: 'system', content: 'Be concise.' },
                { role: 'user', content: 'Hi' },
            ],
        };
        const result = converter.toClaudeRequest(req);
        expect(result.system).toBe('Be concise.');
        // System message is not duplicated in messages array
        const sysMsg = result.messages.find(m => m.role === 'system');
        expect(sysMsg).toBeUndefined();
    });

    test('tool message becomes tool_result block', () => {
        const req = {
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'fn', arguments: '{}' } }],
                },
                { role: 'tool', tool_call_id: 'tc1', content: 'tool output' },
            ],
        };
        const result = converter.toClaudeRequest(req);
        const toolResult = result.messages.find(m =>
            Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')
        );
        expect(toolResult).toBeDefined();
    });

    test('tool_calls become tool_use blocks', () => {
        const req = {
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'search', arguments: '{"q":"test"}' },
                    }],
                },
            ],
        };
        const result = converter.toClaudeRequest(req);
        const assistantMsg = result.messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg.content[0].type).toBe('tool_use');
        expect(assistantMsg.content[0].name).toBe('search');
    });

    test('base64 image_url becomes claude image block', () => {
        const req = {
            messages: [{
                role: 'user',
                content: [{
                    type: 'image_url',
                    image_url: { url: 'data:image/png;base64,abc123' },
                }],
            }],
        };
        const result = converter.toClaudeRequest(req);
        const imgBlock = result.messages[0].content.find(c => c.type === 'image');
        expect(imgBlock).toBeDefined();
        expect(imgBlock.source.type).toBe('base64');
        expect(imgBlock.source.data).toBe('abc123');
    });

    test('thinking passthrough via extra_body', () => {
        const req = {
            messages: [],
            extra_body: {
                anthropic: {
                    thinking: { type: 'enabled', budget_tokens: 5000 },
                },
            },
        };
        const result = converter.toClaudeRequest(req);
        expect(result.thinking).toBeDefined();
        expect(result.thinking.type).toBe('enabled');
        expect(result.thinking.budget_tokens).toBe(5000);
    });
});

// ============================================================================
// OpenAI -> Claude response
// ============================================================================

describe('OpenAIConverter.toClaudeResponse', () => {
    test('null / empty choices returns empty claude response', () => {
        const result = converter.toClaudeResponse(null, 'gpt-4');
        expect(result.type).toBe('message');
        expect(result.content).toEqual([]);
        expect(result.stop_reason).toBe('end_turn');
    });

    test('text content is mapped to text block', () => {
        const openaiResp = {
            choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
        const result = converter.toClaudeResponse(openaiResp, 'gpt-4');
        expect(result.role).toBe('assistant');
        const textBlock = result.content.find(c => c.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock.text).toBe('Hello!');
    });

    test('tool_calls become tool_use blocks', () => {
        const openaiResp = {
            choices: [{
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'myFn', arguments: '{"x":1}' },
                    }],
                },
                finish_reason: 'tool_calls',
            }],
            usage: {},
        };
        const result = converter.toClaudeResponse(openaiResp, 'gpt-4');
        const toolUse = result.content.find(c => c.type === 'tool_use');
        expect(toolUse).toBeDefined();
        expect(toolUse.name).toBe('myFn');
        expect(toolUse.input).toEqual({ x: 1 });
    });

    test('finish_reason=length maps to stop_reason=max_tokens', () => {
        const openaiResp = {
            choices: [{
                message: { role: 'assistant', content: 'truncated' },
                finish_reason: 'length',
            }],
            usage: {},
        };
        const result = converter.toClaudeResponse(openaiResp, 'gpt-4');
        expect(result.stop_reason).toBe('max_tokens');
    });

    test('reasoning_content becomes thinking block', () => {
        const openaiResp = {
            choices: [{
                message: { role: 'assistant', content: 'Answer', reasoning_content: 'My thought' },
                finish_reason: 'stop',
            }],
            usage: {},
        };
        const result = converter.toClaudeResponse(openaiResp, 'gpt-4');
        const thinkBlock = result.content.find(c => c.type === 'thinking');
        expect(thinkBlock).toBeDefined();
        expect(thinkBlock.thinking).toBe('My thought');
    });
});

// ============================================================================
// OpenAI -> Claude stream chunk
// ============================================================================

describe('OpenAIConverter.toClaudeStreamChunk', () => {
    test('null chunk returns null', () => {
        expect(converter.toClaudeStreamChunk(null, 'gpt-4')).toBeNull();
    });

    test('chunk without choices returns null', () => {
        expect(converter.toClaudeStreamChunk({ choices: [] }, 'gpt-4')).toBeNull();
    });

    test('text content delta becomes text_delta event', () => {
        const chunk = {
            choices: [{ delta: { content: 'hello' }, finish_reason: null }],
        };
        const events = converter.toClaudeStreamChunk(chunk, 'gpt-4');
        expect(Array.isArray(events)).toBe(true);
        const textDelta = events.find(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta');
        expect(textDelta).toBeDefined();
        expect(textDelta.delta.text).toBe('hello');
    });

    test('reasoning_content delta becomes thinking_delta event', () => {
        const chunk = {
            choices: [{ delta: { reasoning_content: 'thinking...' }, finish_reason: null }],
        };
        const events = converter.toClaudeStreamChunk(chunk, 'gpt-4');
        expect(Array.isArray(events)).toBe(true);
        const thinkDelta = events.find(e => e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta');
        expect(thinkDelta).toBeDefined();
    });

    test('finish_reason emits message_delta and message_stop', () => {
        const chunk = {
            choices: [{ delta: {}, finish_reason: 'stop' }],
        };
        const events = converter.toClaudeStreamChunk(chunk, 'gpt-4');
        expect(events.some(e => e.type === 'message_delta')).toBe(true);
        expect(events.some(e => e.type === 'message_stop')).toBe(true);
    });

    test('string chunk is converted to text_delta event', () => {
        const result = converter.toClaudeStreamChunk('hello world', 'gpt-4');
        expect(result.type).toBe('content_block_delta');
        expect(result.delta.type).toBe('text_delta');
        expect(result.delta.text).toBe('hello world');
    });
});

// ============================================================================
// OpenAI -> Gemini request (basic)
// ============================================================================

describe('OpenAIConverter.toGeminiRequest', () => {
    test('user message becomes user role in contents', () => {
        const req = { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] };
        const result = converter.toGeminiRequest(req);
        expect(Array.isArray(result.contents)).toBe(true);
        const userContent = result.contents.find(c => c.role === 'user');
        expect(userContent).toBeDefined();
    });

    test('system message becomes system_instruction', () => {
        const req = {
            model: 'gpt-4',
            messages: [
                { role: 'system', content: 'Be helpful.' },
                { role: 'user', content: 'Hi' },
            ],
        };
        const result = converter.toGeminiRequest(req);
        // OpenAIConverter uses snake_case: system_instruction (not systemInstruction)
        expect(result.system_instruction).toBeDefined();
    });

    test('assistant message is mapped to model role', () => {
        const req = {
            model: 'gpt-4',
            messages: [
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hello' },
            ],
        };
        const result = converter.toGeminiRequest(req);
        const modelContent = result.contents.find(c => c.role === 'model');
        expect(modelContent).toBeDefined();
    });
});

// ============================================================================
// Model list conversion
// ============================================================================

describe('OpenAIConverter.convertModelList', () => {
    test('ensureDisplayName adds display_name from id if missing', () => {
        const models = { data: [{ id: 'gpt-4', object: 'model' }] };
        const result = converter.convertModelList(models, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.data[0].display_name).toBe('gpt-4');
    });

    test('toClaudeModelList converts data to models array', () => {
        const models = { data: [{ id: 'gpt-4' }] };
        const result = converter.convertModelList(models, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(Array.isArray(result.models)).toBe(true);
        expect(result.models[0].name).toBe('gpt-4');
    });

    test('toGeminiModelList adds models/ prefix', () => {
        const models = { data: [{ id: 'gpt-4' }] };
        const result = converter.convertModelList(models, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.models[0].name).toBe('models/gpt-4');
    });
});

// ============================================================================
// buildClaudeToolChoice
// ============================================================================

describe('OpenAIConverter.buildClaudeToolChoice', () => {
    test('auto maps to { type: "auto" }', () => {
        expect(converter.buildClaudeToolChoice('auto')).toEqual({ type: 'auto' });
    });

    test('required maps to { type: "any" }', () => {
        expect(converter.buildClaudeToolChoice('required')).toEqual({ type: 'any' });
    });

    test('none maps to { type: "none" }', () => {
        expect(converter.buildClaudeToolChoice('none')).toEqual({ type: 'none' });
    });

    test('object with function.name maps to { type: "tool", name }', () => {
        const result = converter.buildClaudeToolChoice({ function: { name: 'myTool' } });
        expect(result).toEqual({ type: 'tool', name: 'myTool' });
    });
});
