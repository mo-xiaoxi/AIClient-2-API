import { describe, test, expect } from '@jest/globals';
import { ClaudeConverter } from '../../../src/converters/strategies/ClaudeConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';

const converter = new ClaudeConverter();

// ============================================================================
// convertRequest routing
// ============================================================================

describe('ClaudeConverter.convertRequest routing', () => {
    test('throws for unsupported target protocol', () => {
        expect(() => converter.convertRequest({ messages: [] }, 'unknown-proto')).toThrow(
            'Unsupported target protocol'
        );
    });

    test('returns openai-shaped object for OPENAI target', () => {
        const result = converter.convertRequest(
            { messages: [{ role: 'user', content: 'hi' }] },
            MODEL_PROTOCOL_PREFIX.OPENAI
        );
        expect(result).toHaveProperty('messages');
    });

    test('returns gemini-shaped object for GEMINI target', () => {
        const result = converter.convertRequest(
            { messages: [{ role: 'user', content: 'hi' }] },
            MODEL_PROTOCOL_PREFIX.GEMINI
        );
        expect(result).toHaveProperty('contents');
    });
});

// ============================================================================
// convertResponse routing
// ============================================================================

describe('ClaudeConverter.convertResponse routing', () => {
    test('throws for unsupported target protocol', () => {
        expect(() => converter.convertResponse({}, 'unknown-proto', 'model')).toThrow(
            'Unsupported target protocol'
        );
    });
});

// ============================================================================
// Claude -> OpenAI request (toOpenAIRequest)
// ============================================================================

describe('ClaudeConverter.toOpenAIRequest', () => {
    test('simple text message is converted', () => {
        const req = {
            model: 'claude-3-sonnet',
            messages: [{ role: 'user', content: 'Hello' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
    });

    test('system field becomes first message', () => {
        const req = {
            model: 'claude-3-sonnet',
            system: 'You are helpful.',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.messages[0].role).toBe('system');
        expect(result.messages[0].content).toBe('You are helpful.');
    });

    test('tool_use in assistant message becomes tool_calls', () => {
        const req = {
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', id: 'tool-1', name: 'search', input: { q: 'test' } },
                    ],
                },
                {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const assistantMsg = result.messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect(Array.isArray(assistantMsg.tool_calls)).toBe(true);
        expect(assistantMsg.tool_calls[0].function.name).toBe('search');
    });

    test('tool_result in user message becomes tool-role message', () => {
        const req = {
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', id: 'tool-2', name: 'calc', input: {} },
                    ],
                },
                {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: '42' }],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const toolMsg = result.messages.find(m => m.role === 'tool');
        expect(toolMsg).toBeDefined();
        expect(toolMsg.tool_call_id).toBe('tool-2');
        expect(toolMsg.content).toBe('42');
    });

    test('tools array is converted to openai function tools', () => {
        const req = {
            messages: [],
            tools: [
                { name: 'myTool', description: 'Does things', input_schema: { type: 'object', properties: {} } },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(Array.isArray(result.tools)).toBe(true);
        expect(result.tools[0].type).toBe('function');
        expect(result.tools[0].function.name).toBe('myTool');
    });

    test('thinking enabled maps to reasoning_effort', () => {
        const req = {
            model: 'claude-3-7-sonnet',
            max_tokens: 5000,
            messages: [],
            thinking: { type: 'enabled', budget_tokens: 10000 },
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result).toHaveProperty('reasoning_effort');
        expect(result).toHaveProperty('max_completion_tokens');
    });
});

// ============================================================================
// Claude -> OpenAI response (toOpenAIResponse)
// ============================================================================

describe('ClaudeConverter.toOpenAIResponse', () => {
    test('text content block is converted to message content string', () => {
        const claudeResp = {
            content: [{ type: 'text', text: 'Hello world' }],
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.content).toBe('Hello world');
    });

    test('empty content returns empty string', () => {
        const claudeResp = { content: [], usage: {} };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].message.content).toBe('');
    });

    test('empty/missing content response returns empty string', () => {
        // null content array treated as empty
        const claudeResp = { content: null, usage: {} };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].message.content).toBe('');
    });

    test('stop_reason=tool_use maps to finish_reason=tool_calls', () => {
        const claudeResp = {
            content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} }],
            stop_reason: 'tool_use',
            usage: {},
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(Array.isArray(result.choices[0].message.tool_calls)).toBe(true);
    });

    test('stop_reason=max_tokens maps to finish_reason=length', () => {
        const claudeResp = {
            content: [{ type: 'text', text: 'truncated' }],
            stop_reason: 'max_tokens',
            usage: {},
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].finish_reason).toBe('length');
    });

    test('thinking blocks surface as reasoning_content', () => {
        const claudeResp = {
            content: [
                { type: 'thinking', thinking: 'I am thinking...' },
                { type: 'text', text: 'Answer' },
            ],
            stop_reason: 'end_turn',
            usage: {},
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].message.reasoning_content).toBe('I am thinking...');
        expect(result.choices[0].message.content).toBe('Answer');
    });

    test('usage is mapped correctly', () => {
        const claudeResp = {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
        };
        const result = converter.convertResponse(claudeResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.usage.prompt_tokens).toBe(100);
        expect(result.usage.completion_tokens).toBe(50);
        expect(result.usage.cached_tokens).toBe(10);
    });
});

// ============================================================================
// Claude -> OpenAI stream chunks (toOpenAIStreamChunk)
// ============================================================================

describe('ClaudeConverter.toOpenAIStreamChunk', () => {
    test('null chunk returns null', () => {
        expect(converter.convertStreamChunk(null, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3')).toBeNull();
    });

    test('message_start chunk returns role:assistant delta', () => {
        const chunk = { type: 'message_start', message: { usage: { input_tokens: 5 } } };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.object).toBe('chat.completion.chunk');
        expect(result.choices[0].delta.role).toBe('assistant');
    });

    test('content_block_delta text_delta returns content delta', () => {
        const chunk = {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hello' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.content).toBe('hello');
    });

    test('content_block_delta thinking_delta returns reasoning_content delta', () => {
        const chunk = {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'thought' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.reasoning_content).toBe('thought');
    });

    test('content_block_start with tool_use returns tool_calls delta', () => {
        const chunk = {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call-1', name: 'myFn' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.tool_calls[0].function.name).toBe('myFn');
    });

    test('content_block_delta input_json_delta returns partial arguments', () => {
        const chunk = {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"a":' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].delta.tool_calls[0].function.arguments).toBe('{"a":');
    });

    test('message_delta with end_turn sets finish_reason=stop', () => {
        const chunk = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('message_delta with tool_use sets finish_reason=tool_calls', () => {
        const chunk = { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    test('message_stop returns null', () => {
        const chunk = { type: 'message_stop' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'claude-3');
        expect(result).toBeNull();
    });

    test('throws for unsupported target protocol in stream chunk', () => {
        expect(() => converter.convertStreamChunk({}, 'bad-proto', 'model')).toThrow(
            'Unsupported target protocol'
        );
    });
});

// ============================================================================
// Claude -> Gemini request
// ============================================================================

describe('ClaudeConverter.toGeminiRequest', () => {
    test('basic message is converted to Gemini contents array', () => {
        const req = {
            messages: [{ role: 'user', content: 'Hello Gemini' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(Array.isArray(result.contents)).toBe(true);
        expect(result.contents.length).toBeGreaterThan(0);
    });

    test('system field becomes systemInstruction', () => {
        const req = {
            system: 'Be concise.',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result).toHaveProperty('systemInstruction');
    });

    test('invalid input returns empty contents', () => {
        const result = converter.convertRequest(null, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.contents).toEqual([]);
    });
});

// ============================================================================
// Model list conversion
// ============================================================================

describe('ClaudeConverter.convertModelList', () => {
    test('toOpenAIModelList maps Claude models to OpenAI format', () => {
        const claudeModels = {
            models: [{ id: 'claude-3-opus-20240229' }],
        };
        const result = converter.convertModelList(claudeModels, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.object).toBe('list');
        expect(result.data[0].id).toBe('claude-3-opus-20240229');
        expect(result.data[0].owned_by).toBe('anthropic');
    });

    test('toGeminiModelList maps Claude models to Gemini format', () => {
        const claudeModels = {
            models: [{ id: 'claude-3-sonnet', name: 'claude-3-sonnet' }],
        };
        const result = converter.convertModelList(claudeModels, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.models[0].name).toContain('models/');
    });
});
