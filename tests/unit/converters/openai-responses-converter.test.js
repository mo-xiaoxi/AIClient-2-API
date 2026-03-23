import { describe, test, expect } from '@jest/globals';
import { OpenAIResponsesConverter } from '../../../src/converters/strategies/OpenAIResponsesConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';

const converter = new OpenAIResponsesConverter();

// ============================================================================
// convertRequest routing
// ============================================================================

describe('OpenAIResponsesConverter.convertRequest routing', () => {
    test('throws for unsupported target protocol', () => {
        expect(() => converter.convertRequest({}, 'unknown-proto')).toThrow('Unsupported target protocol');
    });

    test('returns openai-shaped object for OPENAI target', () => {
        const result = converter.convertRequest({ model: 'm', input: [] }, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result).toHaveProperty('messages');
    });

    test('returns claude-shaped object for CLAUDE target', () => {
        const result = converter.convertRequest({ model: 'm', input: [] }, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result).toHaveProperty('messages');
        expect(result).toHaveProperty('max_tokens');
    });

    test('returns gemini-shaped object for GEMINI target', () => {
        const result = converter.convertRequest({ model: 'm', input: [] }, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result).toHaveProperty('contents');
    });
});

// ============================================================================
// toOpenAIRequest
// ============================================================================

describe('OpenAIResponsesConverter.toOpenAIRequest', () => {
    test('instructions become system message', () => {
        const req = { model: 'm', instructions: 'Be helpful.', input: [] };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const sys = result.messages.find(m => m.role === 'system');
        expect(sys).toBeDefined();
        expect(sys.content).toBe('Be helpful.');
    });

    test('input message item is converted to messages', () => {
        const req = {
            model: 'm',
            input: [{ type: 'message', role: 'user', content: 'Hello' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content).toBe('Hello');
    });

    test('max_output_tokens is mapped to max_tokens', () => {
        const req = { model: 'm', input: [], max_output_tokens: 2000 };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.max_tokens).toBe(2000);
    });

    test('function_call input item becomes assistant tool_calls message', () => {
        const req = {
            model: 'm',
            input: [{
                type: 'function_call',
                call_id: 'call-1',
                name: 'search',
                arguments: '{"q":"test"}',
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const assistantMsg = result.messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg.tool_calls[0].id).toBe('call-1');
    });

    test('function_call_output item becomes tool role message', () => {
        const req = {
            model: 'm',
            input: [{
                type: 'function_call_output',
                call_id: 'call-2',
                output: 'result data',
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const toolMsg = result.messages.find(m => m.role === 'tool');
        expect(toolMsg).toBeDefined();
        expect(toolMsg.tool_call_id).toBe('call-2');
        expect(toolMsg.content).toBe('result data');
    });

    test('function tools are converted and filtered', () => {
        const req = {
            model: 'm',
            input: [],
            tools: [
                { type: 'function', name: 'myFn', description: 'desc', parameters: {} },
                { type: 'unknown_type', name: 'bad' },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(Array.isArray(result.tools)).toBe(true);
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].function.name).toBe('myFn');
    });

    test('developer role is mapped to assistant', () => {
        const req = {
            model: 'm',
            input: [{ type: 'message', role: 'developer', content: 'system-like' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const msg = result.messages.find(m => m.role === 'assistant');
        expect(msg).toBeDefined();
    });
});

// ============================================================================
// toOpenAIResponse
// ============================================================================

describe('OpenAIResponsesConverter.toOpenAIResponse', () => {
    test('throws for unsupported target protocol', () => {
        expect(() => converter.convertResponse({}, 'unknown-proto', 'm')).toThrow('Unsupported target protocol');
    });

    test('message output item is converted to choice', () => {
        const resp = {
            id: 'resp-1',
            output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'Hello' }],
            }],
            status: 'completed',
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-4');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.content).toBe('Hello');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('function_call output item is converted to tool_calls choice', () => {
        const resp = {
            id: 'resp-2',
            output: [{
                type: 'function_call',
                call_id: 'call-3',
                name: 'myFn',
                arguments: '{"x":1}',
            }],
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-4');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(result.choices[0].message.tool_calls[0].id).toBe('call-3');
    });

    test('empty output returns default empty choice', () => {
        const resp = { id: 'resp-3', output: [] };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-4');
        expect(result.choices[0].message.content).toBe('');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('usage is mapped from response', () => {
        const resp = {
            id: 'resp-4',
            output: [],
            usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-4');
        expect(result.usage.prompt_tokens).toBe(20);
        expect(result.usage.completion_tokens).toBe(10);
        expect(result.usage.total_tokens).toBe(30);
    });
});

// ============================================================================
// toOpenAIStreamChunk
// ============================================================================

describe('OpenAIResponsesConverter.toOpenAIStreamChunk', () => {
    test('throws for unsupported target protocol in stream chunk', () => {
        expect(() => converter.convertStreamChunk({}, 'unknown-proto', 'm')).toThrow('Unsupported target protocol');
    });

    test('response.output_text.delta produces content delta', () => {
        const chunk = { type: 'response.output_text.delta', delta: 'hello' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-4');
        expect(result.choices[0].delta.content).toBe('hello');
    });

    test('response.function_call_arguments.delta produces tool_calls delta', () => {
        const chunk = { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-4');
        expect(result.choices[0].delta.tool_calls[0].function.arguments).toBe('{"q":');
    });

    test('response.completed sets finish_reason=stop', () => {
        const chunk = { type: 'response.completed' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-4');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('response.output_item.added with function_call produces tool_calls delta', () => {
        const chunk = {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', call_id: 'c1', name: 'myFn' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-4');
        expect(result.choices[0].delta.tool_calls[0].function.name).toBe('myFn');
    });
});

// ============================================================================
// toClaudeRequest
// ============================================================================

describe('OpenAIResponsesConverter.toClaudeRequest', () => {
    test('instructions become system field', () => {
        const req = { model: 'm', instructions: 'Be concise.', input: [] };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.system).toBe('Be concise.');
    });

    test('reasoning effort is converted to thinking budget', () => {
        const req = { model: 'm', input: [], reasoning: { effort: 'high' } };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.thinking).toBeDefined();
        expect(result.thinking.type).toBe('enabled');
        expect(result.thinking.budget_tokens).toBe(20000);
    });

    test('function_call item becomes tool_use block', () => {
        const req = {
            model: 'm',
            input: [{
                type: 'function_call',
                call_id: 'call-a',
                name: 'fn',
                arguments: '{"x":1}',
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CLAUDE);
        const assistantMsg = result.messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg.content[0].type).toBe('tool_use');
    });

    test('function_call_output item becomes tool_result block', () => {
        const req = {
            model: 'm',
            input: [{
                type: 'function_call_output',
                call_id: 'call-b',
                output: 'output data',
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CLAUDE);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content[0].type).toBe('tool_result');
    });
});

// ============================================================================
// toClaudeStreamChunk
// ============================================================================

describe('OpenAIResponsesConverter.toClaudeStreamChunk', () => {
    test('response.created becomes message_start', () => {
        const chunk = { type: 'response.created', response: { id: 'r1', model: 'gpt-4' } };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gpt-4');
        expect(result.type).toBe('message_start');
        expect(result.message.role).toBe('assistant');
    });

    test('response.output_text.delta becomes content_block_delta', () => {
        const chunk = { type: 'response.output_text.delta', delta: 'world' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gpt-4');
        expect(result.type).toBe('content_block_delta');
        expect(result.delta.text).toBe('world');
    });

    test('response.completed becomes message_stop', () => {
        const chunk = { type: 'response.completed' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gpt-4');
        expect(result.type).toBe('message_stop');
    });

    test('unknown event type returns null', () => {
        const chunk = { type: 'response.something_else' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gpt-4');
        expect(result).toBeNull();
    });
});

// ============================================================================
// toGeminiRequest
// ============================================================================

describe('OpenAIResponsesConverter.toGeminiRequest', () => {
    test('instructions become systemInstruction', () => {
        const req = { model: 'm', instructions: 'Be concise.', input: [] };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.systemInstruction).toBeDefined();
        expect(result.systemInstruction.parts[0].text).toBe('Be concise.');
    });

    test('user message becomes user role in contents', () => {
        const req = {
            model: 'm',
            input: [{ type: 'message', role: 'user', content: 'Hi' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.contents.length).toBeGreaterThan(0);
        expect(result.contents[0].role).toBe('user');
    });

    test('max_output_tokens goes to generationConfig', () => {
        const req = { model: 'm', input: [], max_output_tokens: 500 };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.generationConfig.maxOutputTokens).toBe(500);
    });
});

// ============================================================================
// Model list conversion
// ============================================================================

describe('OpenAIResponsesConverter.convertModelList', () => {
    test('already-standard list is returned unchanged', () => {
        const models = { object: 'list', data: [{ id: 'gpt-4' }] };
        const result = converter.convertModelList(models, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.object).toBe('list');
        expect(result.data[0].id).toBe('gpt-4');
    });

    test('toClaudeModelList wraps models', () => {
        const models = { data: [{ id: 'gpt-4' }] };
        const result = converter.convertModelList(models, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(Array.isArray(result.models)).toBe(true);
        expect(result.models[0].name).toBe('gpt-4');
    });

    test('toGeminiModelList adds models/ prefix', () => {
        const models = { data: [{ id: 'gpt-4' }] };
        const result = converter.convertModelList(models, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.models[0].name).toContain('models/');
    });
});
