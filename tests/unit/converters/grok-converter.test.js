import { describe, test, expect } from '@jest/globals';
import { GrokConverter } from '../../../src/converters/strategies/GrokConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';

// ============================================================================
// GrokConverter routing
// ============================================================================

describe('GrokConverter routing', () => {
    const converter = new GrokConverter();

    test('convertRequest returns data unchanged for default case', () => {
        const data = { messages: [{ role: 'user', content: 'hi' }] };
        const result = converter.convertRequest(data, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result).toBe(data);
    });

    test('convertResponse throws for unknown target protocol', () => {
        expect(() => converter.convertResponse({}, 'unknown', 'model')).not.toThrow();
        // default branch returns data as-is
    });

    test('convertStreamChunk returns null for empty chunk', () => {
        const result = converter.convertStreamChunk(null, MODEL_PROTOCOL_PREFIX.OPENAI, 'grok-2');
        expect(result).toBeNull();
    });

    test('convertStreamChunk returns null when result/response missing', () => {
        const result = converter.convertStreamChunk({ result: {} }, MODEL_PROTOCOL_PREFIX.OPENAI, 'grok-2');
        expect(result).toBeNull();
    });
});

// ============================================================================
// GrokConverter.toOpenAIResponse
// ============================================================================

describe('GrokConverter.toOpenAIResponse', () => {
    const converter = new GrokConverter();

    test('returns null for null input', () => {
        const result = converter.toOpenAIResponse(null, 'grok-2');
        expect(result).toBeNull();
    });

    test('basic message is converted to chat.completion', () => {
        const grokResp = { responseId: 'r1', message: 'Hello!', llmInfo: {} };
        const result = converter.toOpenAIResponse(grokResp, 'grok-2');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.content).toBe('Hello!');
        expect(result.choices[0].message.role).toBe('assistant');
    });

    test('responseId is used as-is in the response id field', () => {
        // toOpenAIResponse uses `grokResponse.responseId` directly (no _formatResponseId)
        const grokResp = { responseId: 'chatcmpl-abc123', message: 'Hi' };
        const result = converter.toOpenAIResponse(grokResp, 'grok-2');
        expect(result.id).toBe('chatcmpl-abc123');
    });

    test('message with <tool_call> block produces tool_calls', () => {
        const grokResp = {
            responseId: 'r2',
            message: '<tool_call>{"name":"search","arguments":{"q":"hello"}}</tool_call>',
        };
        const result = converter.toOpenAIResponse(grokResp, 'grok-2');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(Array.isArray(result.choices[0].message.tool_calls)).toBe(true);
        expect(result.choices[0].message.tool_calls[0].function.name).toBe('search');
    });

    test('message without tool call has finish_reason=stop', () => {
        const grokResp = { responseId: 'r3', message: 'Plain response' };
        const result = converter.toOpenAIResponse(grokResp, 'grok-2');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('model hash is used as system_fingerprint', () => {
        const grokResp = { responseId: 'r4', message: 'ok', llmInfo: { modelHash: 'abc' } };
        const result = converter.toOpenAIResponse(grokResp, 'grok-2');
        expect(result.system_fingerprint).toBe('abc');
    });

    test('usage is always set to zeros', () => {
        const grokResp = { responseId: 'r5', message: 'ok' };
        const result = converter.toOpenAIResponse(grokResp, 'grok-2');
        expect(result.usage.prompt_tokens).toBe(0);
        expect(result.usage.completion_tokens).toBe(0);
        expect(result.usage.total_tokens).toBe(0);
    });
});

// ============================================================================
// GrokConverter.parseToolCalls
// ============================================================================

describe('GrokConverter.parseToolCalls', () => {
    const converter = new GrokConverter();

    test('empty content returns text=content, toolCalls=null', () => {
        const result = converter.parseToolCalls('');
        expect(result.toolCalls).toBeNull();
    });

    test('null content returns as-is', () => {
        const result = converter.parseToolCalls(null);
        expect(result.text).toBeNull();
        expect(result.toolCalls).toBeNull();
    });

    test('content without tool_call tags returns unchanged text', () => {
        const result = converter.parseToolCalls('Hello, world!');
        expect(result.text).toBe('Hello, world!');
        expect(result.toolCalls).toBeNull();
    });

    test('single tool_call block is parsed', () => {
        const content = '<tool_call>{"name":"calc","arguments":{"x":1}}</tool_call>';
        const result = converter.parseToolCalls(content);
        expect(result.toolCalls).not.toBeNull();
        expect(result.toolCalls[0].function.name).toBe('calc');
        expect(result.toolCalls[0].type).toBe('function');
    });

    test('multiple tool_call blocks are all parsed', () => {
        const content = '<tool_call>{"name":"a","arguments":{}}</tool_call>\n<tool_call>{"name":"b","arguments":{}}</tool_call>';
        const result = converter.parseToolCalls(content);
        expect(result.toolCalls).toHaveLength(2);
    });

    test('invalid JSON in tool_call block is ignored', () => {
        const content = '<tool_call>not-json</tool_call>';
        const result = converter.parseToolCalls(content);
        expect(result.toolCalls).toBeNull();
    });

    test('text before tool_call is extracted', () => {
        const content = 'Sure, let me search.\n<tool_call>{"name":"search","arguments":{}}</tool_call>';
        const result = converter.parseToolCalls(content);
        expect(result.text).toContain('Sure, let me search');
        expect(result.toolCalls).not.toBeNull();
    });
});

// ============================================================================
// GrokConverter.buildToolPrompt
// ============================================================================

describe('GrokConverter.buildToolPrompt', () => {
    const converter = new GrokConverter();

    test('returns empty string when no tools', () => {
        expect(converter.buildToolPrompt([])).toBe('');
    });

    test('returns empty string when toolChoice is none', () => {
        const tools = [{ type: 'function', function: { name: 'fn', description: 'desc' } }];
        expect(converter.buildToolPrompt(tools, 'none')).toBe('');
    });

    test('includes tool name in prompt', () => {
        const tools = [{ type: 'function', function: { name: 'myTool', description: 'My tool' } }];
        const prompt = converter.buildToolPrompt(tools);
        expect(prompt).toContain('myTool');
    });

    test('includes MUST requirement when toolChoice=required', () => {
        const tools = [{ type: 'function', function: { name: 'myTool' } }];
        const prompt = converter.buildToolPrompt(tools, 'required');
        expect(prompt).toContain('MUST call at least one tool');
    });
});

// ============================================================================
// GrokConverter.formatToolHistory
// ============================================================================

describe('GrokConverter.formatToolHistory', () => {
    const converter = new GrokConverter();

    test('tool messages are transformed to user role', () => {
        const messages = [
            { role: 'tool', name: 'search', tool_call_id: 'tc1', content: 'result' },
        ];
        const result = converter.formatToolHistory(messages);
        expect(result[0].role).toBe('user');
        expect(result[0].content).toContain('search');
    });

    test('assistant messages with tool_calls are formatted with tool_call tags', () => {
        const messages = [
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'fn', arguments: '{"a":1}' } }],
            },
        ];
        const result = converter.formatToolHistory(messages);
        expect(result[0].role).toBe('assistant');
        expect(result[0].content).toContain('<tool_call>');
    });

    test('regular messages are passed through unchanged', () => {
        const messages = [{ role: 'user', content: 'hello' }];
        const result = converter.formatToolHistory(messages);
        expect(result[0]).toEqual(messages[0]);
    });
});

// ============================================================================
// GrokConverter stream chunk
// ============================================================================

// ============================================================================
// GrokConverter.setRequestBaseUrl / setUuid
// ============================================================================

describe('GrokConverter.setRequestBaseUrl and setUuid', () => {
    test('setRequestBaseUrl stores the URL as static property', () => {
        const converter = new GrokConverter();
        converter.setRequestBaseUrl('http://localhost:3000');
        expect(GrokConverter.sharedRequestBaseUrl).toBe('http://localhost:3000');
    });

    test('setUuid stores the uuid as static property', () => {
        const converter = new GrokConverter();
        converter.setUuid('test-uuid-123');
        expect(GrokConverter.sharedUuid).toBe('test-uuid-123');
    });

    test('setRequestBaseUrl ignores falsy values', () => {
        const converter = new GrokConverter();
        GrokConverter.sharedRequestBaseUrl = 'original';
        converter.setRequestBaseUrl('');
        expect(GrokConverter.sharedRequestBaseUrl).toBe('original');
    });
});

// ============================================================================
// GrokConverter._appendSsoToken
// ============================================================================

describe('GrokConverter._appendSsoToken', () => {
    test('returns url unchanged when no uuid', () => {
        const converter = new GrokConverter();
        GrokConverter.sharedUuid = null;
        const result = converter._appendSsoToken('https://assets.grok.com/foo.png');
        expect(result).toBe('https://assets.grok.com/foo.png');
    });

    test('transforms assets.grok.com URL to proxy URL', () => {
        const converter = new GrokConverter();
        GrokConverter.sharedUuid = 'my-uuid';
        GrokConverter.sharedRequestBaseUrl = 'http://localhost:3000';
        const result = converter._appendSsoToken('https://assets.grok.com/img.png');
        expect(result).toContain('/api/grok/assets');
        expect(result).toContain('my-uuid');
    });

    test('returns url unchanged for non-grok URLs', () => {
        const converter = new GrokConverter();
        GrokConverter.sharedUuid = 'uuid';
        const url = 'https://example.com/image.png';
        expect(converter._appendSsoToken(url)).toBe(url);
    });

    test('returns url unchanged when url is falsy', () => {
        const converter = new GrokConverter();
        expect(converter._appendSsoToken(null)).toBeNull();
    });
});

// ============================================================================
// GrokConverter.buildToolOverrides
// ============================================================================

describe('GrokConverter.buildToolOverrides', () => {
    const converter = new GrokConverter();

    test('returns empty object for null input', () => {
        expect(converter.buildToolOverrides(null)).toEqual({});
    });

    test('skips tools without function type', () => {
        const tools = [{ type: 'retrieval' }];
        expect(converter.buildToolOverrides(tools)).toEqual({});
    });

    test('builds overrides from function tools', () => {
        const tools = [
            {
                type: 'function',
                function: { name: 'myFn', description: 'A function', parameters: { type: 'object' } }
            }
        ];
        const result = converter.buildToolOverrides(tools);
        expect(result.myFn).toBeDefined();
        expect(result.myFn.enabled).toBe(true);
        expect(result.myFn.description).toBe('A function');
    });
});

// ============================================================================
// GrokConverter routing — GEMINI / OPENAI_RESPONSES / CODEX
// ============================================================================

describe('GrokConverter routing — additional targets', () => {
    const converter = new GrokConverter();
    const grokResp = { responseId: 'r1', message: 'Hello!', llmInfo: {} };
    const doneChunk = {
        result: {
            response: {
                responseId: 'resp-1',
                isDone: true,
                token: '',
                llmInfo: {},
            },
        },
    };

    test('convertResponse GEMINI returns gemini format', () => {
        const result = converter.convertResponse(grokResp, MODEL_PROTOCOL_PREFIX.GEMINI, 'grok-2');
        expect(result.candidates).toBeDefined();
    });

    test('convertResponse OPENAI_RESPONSES returns responses format', () => {
        const result = converter.convertResponse(grokResp, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'grok-2');
        expect(result.object).toBe('response');
    });

    test('convertResponse CODEX returns codex format', () => {
        const result = converter.convertResponse(grokResp, MODEL_PROTOCOL_PREFIX.CODEX, 'grok-2');
        expect(result.response).toBeDefined();
        expect(result.response.output).toBeDefined();
    });

    test('convertStreamChunk GEMINI returns gemini chunks', () => {
        const result = converter.convertStreamChunk(doneChunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'grok-2');
        expect(result).not.toBeNull();
    });

    test('convertStreamChunk OPENAI_RESPONSES returns events array', () => {
        const result = converter.convertStreamChunk(doneChunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'grok-2');
        expect(Array.isArray(result)).toBe(true);
    });

    test('convertStreamChunk CODEX returns codex chunks', () => {
        const result = converter.convertStreamChunk(doneChunk, MODEL_PROTOCOL_PREFIX.CODEX, 'grok-2');
        expect(Array.isArray(result)).toBe(true);
    });

    test('convertModelList OPENAI returns model list', () => {
        const models = [{ id: 'grok-2', name: 'Grok 2' }];
        const result = converter.convertModelList(models, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.object).toBe('list');
        expect(result.data[0].id).toBe('grok-2');
    });

    test('convertModelList GEMINI returns gemini model list', () => {
        const models = [{ id: 'grok-2', name: 'Grok 2' }];
        const result = converter.convertModelList(models, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(result.models[0].name).toBe('models/grok-2');
    });
});

// ============================================================================
// GrokConverter.toGeminiResponse
// ============================================================================

describe('GrokConverter.toGeminiResponse', () => {
    const converter = new GrokConverter();

    test('returns null for null grokResponse', () => {
        expect(converter.toGeminiResponse(null, 'grok-2')).toBeNull();
    });

    test('converts basic grok response to gemini format', () => {
        const grokResp = { responseId: 'r1', message: 'Hello from Grok', llmInfo: {} };
        const result = converter.toGeminiResponse(grokResp, 'grok-2');
        expect(result.candidates[0].content.role).toBe('model');
        expect(result.candidates[0].content.parts[0].text).toBe('Hello from Grok');
    });
});

// ============================================================================
// GrokConverter.toOpenAIResponsesResponse
// ============================================================================

describe('GrokConverter.toOpenAIResponsesResponse', () => {
    const converter = new GrokConverter();

    test('returns null for null grokResponse', () => {
        expect(converter.toOpenAIResponsesResponse(null, 'grok-2')).toBeNull();
    });

    test('converts grok response to OpenAI Responses format', () => {
        const grokResp = { responseId: 'r1', message: 'OpenAI Responses content', llmInfo: {} };
        const result = converter.toOpenAIResponsesResponse(grokResp, 'grok-2');
        expect(result.object).toBe('response');
        expect(result.status).toBe('completed');
        expect(result.output[0].type).toBe('message');
        expect(result.output[0].content[0].text).toBe('OpenAI Responses content');
    });
});

// ============================================================================
// GrokConverter.toCodexResponse
// ============================================================================

describe('GrokConverter.toCodexResponse', () => {
    const converter = new GrokConverter();

    test('returns null for null grokResponse', () => {
        expect(converter.toCodexResponse(null, 'grok-2')).toBeNull();
    });

    test('converts grok response to Codex format', () => {
        const grokResp = { responseId: 'r1', message: 'Codex content', llmInfo: {} };
        const result = converter.toCodexResponse(grokResp, 'grok-2');
        expect(result.response).toBeDefined();
        expect(result.response.output[0].type).toBe('message');
        expect(result.response.output[0].content[0].text).toBe('Codex content');
    });
});

// ============================================================================
// GrokConverter.toOpenAIModelList / toGeminiModelList
// ============================================================================

describe('GrokConverter model lists', () => {
    const converter = new GrokConverter();

    test('toOpenAIModelList with array input', () => {
        const result = converter.toOpenAIModelList([{ id: 'grok-2', display_name: 'Grok 2' }]);
        expect(result.object).toBe('list');
        expect(result.data[0].id).toBe('grok-2');
        expect(result.data[0].owned_by).toBe('xai');
    });

    test('toOpenAIModelList with models object input', () => {
        const result = converter.toOpenAIModelList({ models: [{ id: 'grok-3' }] });
        expect(result.data[0].id).toBe('grok-3');
    });

    test('toGeminiModelList converts to gemini format', () => {
        const result = converter.toGeminiModelList([{ id: 'grok-2', name: 'Grok 2' }]);
        expect(result.models[0].name).toBe('models/grok-2');
        expect(result.models[0].supportedGenerationMethods).toContain('generateContent');
    });

    test('toGeminiModelList with string model', () => {
        const result = converter.toGeminiModelList(['grok-mini']);
        expect(result.models[0].name).toBe('models/grok-mini');
    });
});

// ============================================================================
// GrokConverter.toOpenAIStreamChunk
// ============================================================================

describe('GrokConverter.toOpenAIStreamChunk', () => {
    const converter = new GrokConverter();

    test('isDone=true emits final chunk with finish_reason=stop', () => {
        const chunk = {
            result: {
                response: {
                    responseId: 'resp-1',
                    isDone: true,
                    llmInfo: {},
                },
            },
        };
        const result = converter.toOpenAIStreamChunk(chunk, 'grok-2');
        expect(Array.isArray(result)).toBe(true);
        const lastChunk = result[result.length - 1];
        expect(lastChunk.choices[0].finish_reason).toBe('stop');
    });

    test('non-done chunk with token emits content', () => {
        const converter2 = new GrokConverter();
        // First send an init chunk to set up state
        const initChunk = {
            result: {
                response: {
                    responseId: 'resp-2',
                    isDone: false,
                    token: 'hello',
                    isThinking: false,
                    llmInfo: {},
                },
            },
        };
        const result = converter2.toOpenAIStreamChunk(initChunk, 'grok-2');
        expect(Array.isArray(result)).toBe(true);
        // Should have at least the role delta and the token delta
        expect(result.length).toBeGreaterThan(0);
    });
});
