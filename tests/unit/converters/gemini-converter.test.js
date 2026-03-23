import { describe, test, expect } from '@jest/globals';
import { GeminiConverter } from '../../../src/converters/strategies/GeminiConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';

const converter = new GeminiConverter();

// ============================================================================
// convertRequest routing
// ============================================================================

describe('GeminiConverter.convertRequest routing', () => {
    test('throws for unsupported target protocol', () => {
        expect(() => converter.convertRequest({ contents: [] }, 'unknown-proto')).toThrow(
            'Unsupported target protocol'
        );
    });

    test('returns openai messages for OPENAI target', () => {
        const req = { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(Array.isArray(result.messages)).toBe(true);
    });

    test('returns claude messages for CLAUDE target', () => {
        const req = { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(Array.isArray(result.messages)).toBe(true);
    });
});

// ============================================================================
// Gemini -> OpenAI request (toOpenAIRequest)
// ============================================================================

describe('GeminiConverter.toOpenAIRequest', () => {
    test('converts Gemini contents to OpenAI messages', () => {
        const req = {
            model: 'gemini-1.5-pro',
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.messages.length).toBeGreaterThan(0);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
    });

    test('model role is mapped to assistant', () => {
        const req = {
            contents: [
                { role: 'user', parts: [{ text: 'Hi' }] },
                { role: 'model', parts: [{ text: 'Hello!' }] },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const assistantMsg = result.messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
    });

    test('systemInstruction becomes system message', () => {
        const req = {
            contents: [],
            systemInstruction: { parts: [{ text: 'Be helpful.' }] },
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const sysMsg = result.messages.find(m => m.role === 'system');
        expect(sysMsg).toBeDefined();
        expect(sysMsg.content).toContain('Be helpful');
    });

    test('inlineData image part is converted to image_url', () => {
        const req = {
            contents: [{
                role: 'user',
                parts: [{ inlineData: { mimeType: 'image/png', data: 'base64abc' } }],
            }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        const imgBlock = Array.isArray(userMsg.content)
            ? userMsg.content.find(c => c.type === 'image_url')
            : null;
        expect(imgBlock).toBeDefined();
        expect(imgBlock.image_url.url).toContain('data:image/png;base64,base64abc');
    });

    test('default max_tokens is applied when not specified', () => {
        const req = { contents: [] };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(typeof result.max_tokens).toBe('number');
        expect(result.max_tokens).toBeGreaterThan(0);
    });
});

// ============================================================================
// Gemini -> OpenAI response (toOpenAIResponse)
// ============================================================================

describe('GeminiConverter.toOpenAIResponse', () => {
    test('text content is extracted from candidates', () => {
        const resp = {
            candidates: [{ content: { parts: [{ text: 'Hello' }], role: 'model' }, finishReason: 'STOP' }],
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.role).toBe('assistant');
    });

    test('functionCall in response produces tool_calls', () => {
        const resp = {
            candidates: [{
                content: {
                    parts: [{ functionCall: { id: 'fc1', name: 'search', args: { q: 'test' } } }],
                    role: 'model',
                },
                finishReason: 'STOP',
            }],
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(Array.isArray(result.choices[0].message.tool_calls)).toBe(true);
        expect(result.choices[0].message.tool_calls[0].function.name).toBe('search');
    });

    test('usageMetadata is mapped to usage', () => {
        const resp = {
            candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.usage.prompt_tokens).toBe(10);
        expect(result.usage.completion_tokens).toBe(5);
        expect(result.usage.total_tokens).toBe(15);
    });

    test('empty candidates returns default structure', () => {
        const resp = { candidates: [] };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].message.role).toBe('assistant');
    });

    test('finish_reason is stop when there are no tool calls', () => {
        const resp = {
            candidates: [{ content: { parts: [{ text: 'short' }], role: 'model' }, finishReason: 'MAX_TOKENS' }],
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        // toOpenAIResponse uses "stop" as default; finishReason mapping happens in stream chunk
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('finish_reason is tool_calls when functionCall present', () => {
        const resp = {
            candidates: [{
                content: {
                    parts: [{ functionCall: { name: 'fn', args: {} } }],
                    role: 'model',
                },
                finishReason: 'STOP',
            }],
        };
        const result = converter.convertResponse(resp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    test('throws for unsupported target protocol', () => {
        expect(() => converter.convertResponse({}, 'unknown-proto', 'gemini-pro')).toThrow(
            'Unsupported target protocol'
        );
    });
});

// ============================================================================
// Gemini -> OpenAI stream chunks (toOpenAIStreamChunk)
// ============================================================================

describe('GeminiConverter.toOpenAIStreamChunk', () => {
    test('null input returns null', () => {
        const result = converter.convertStreamChunk(null, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result).toBeNull();
    });

    test('chunk without candidates returns null', () => {
        const result = converter.convertStreamChunk({ model: 'gemini-pro' }, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result).toBeNull();
    });

    test('text part produces content delta', () => {
        const chunk = {
            candidates: [{
                content: { parts: [{ text: 'hello' }], role: 'model' },
            }],
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].delta.content).toBe('hello');
    });

    test('functionCall part produces tool_calls delta', () => {
        const chunk = {
            candidates: [{
                content: {
                    parts: [{ functionCall: { name: 'myFn', args: { x: 1 } } }],
                    role: 'model',
                },
            }],
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].delta.tool_calls).toBeDefined();
        expect(result.choices[0].delta.tool_calls[0].function.name).toBe('myFn');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    test('STOP finishReason is mapped to stop', () => {
        const chunk = {
            candidates: [{
                content: { parts: [{ text: 'done' }], role: 'model' },
                finishReason: 'STOP',
            }],
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('usageMetadata on chunk is included in result', () => {
        const chunk = {
            candidates: [{ content: { parts: [{ text: 'x' }], role: 'model' } }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.usage).toBeDefined();
        expect(result.usage.prompt_tokens).toBe(3);
    });

    test('throws for unsupported target protocol in stream chunk', () => {
        expect(() => converter.convertStreamChunk({}, 'unknown-proto', 'gemini-pro')).toThrow(
            'Unsupported target protocol'
        );
    });
});

// ============================================================================
// Model list conversion
// ============================================================================

describe('GeminiConverter.convertModelList', () => {
    test('toOpenAIModelList strips models/ prefix', () => {
        const geminiModels = {
            models: [{ name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' }],
        };
        const result = converter.convertModelList(geminiModels, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.object).toBe('list');
        expect(result.data[0].id).toBe('gemini-1.5-pro');
        expect(result.data[0].owned_by).toBe('google');
    });

    test('returns data for default protocol', () => {
        const geminiModels = { models: [{ name: 'gemini-pro' }] };
        const result = converter.convertModelList(geminiModels, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.data).toHaveLength(1);
    });
});
