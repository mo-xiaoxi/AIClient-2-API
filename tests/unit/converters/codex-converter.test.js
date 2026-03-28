import { describe, test, expect } from '@jest/globals';
import { CodexConverter } from '../../../src/converters/strategies/CodexConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';

// ============================================================================
// CodexConverter routing
// ============================================================================

describe('CodexConverter routing', () => {
    const converter = new CodexConverter();

    test('convertRequest always throws', () => {
        expect(() => converter.convertRequest({ messages: [] }, MODEL_PROTOCOL_PREFIX.OPENAI)).toThrow(
            'Unsupported target protocol'
        );
    });

    test('convertResponse throws for unknown protocol', () => {
        expect(() => converter.convertResponse({}, 'unknown-proto', 'model')).toThrow(
            'Unsupported target protocol'
        );
    });

    test('convertStreamChunk throws for unknown protocol', () => {
        expect(() => converter.convertStreamChunk({}, 'unknown-proto', 'model')).toThrow(
            'Unsupported target protocol'
        );
    });

    test('convertModelList returns data unchanged', () => {
        const data = { models: [] };
        const result = converter.convertModelList(data, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result).toBe(data);
    });
});

// ============================================================================
// CodexConverter.toOpenAIResponsesToCodexRequest
// ============================================================================

describe('CodexConverter.toOpenAIResponsesToCodexRequest', () => {
    const converter = new CodexConverter();

    test('converts string input to message array', () => {
        const req = { model: 'o3', input: 'Hello' };
        const result = converter.toOpenAIResponsesToCodexRequest(req);
        expect(Array.isArray(result.input)).toBe(true);
        expect(result.input[0].type).toBe('message');
        expect(result.input[0].content[0].text).toBe('Hello');
    });

    test('sets stream=true always', () => {
        const req = { model: 'o3', input: [] };
        const result = converter.toOpenAIResponsesToCodexRequest(req);
        expect(result.stream).toBe(true);
    });

    test('sets store=false always', () => {
        const req = { model: 'o3', input: [] };
        const result = converter.toOpenAIResponsesToCodexRequest(req);
        expect(result.store).toBe(false);
    });

    test('removes max_output_tokens and temperature', () => {
        const req = { model: 'o3', input: [], max_output_tokens: 100, temperature: 0.5 };
        const result = converter.toOpenAIResponsesToCodexRequest(req);
        expect(result.max_output_tokens).toBeUndefined();
        expect(result.temperature).toBeUndefined();
    });

    test('sets reasoning effort from reasoning_effort field', () => {
        const req = { model: 'o3', input: [], reasoning_effort: 'high' };
        const result = converter.toOpenAIResponsesToCodexRequest(req);
        expect(result.reasoning.effort).toBe('high');
    });

    test('default reasoning effort is medium', () => {
        const req = { model: 'o3', input: [] };
        const result = converter.toOpenAIResponsesToCodexRequest(req);
        expect(result.reasoning.effort).toBe('medium');
    });

    test('system/developer messages are filtered when instructions exist', () => {
        const req = {
            model: 'o3',
            instructions: 'Be helpful.',
            input: [
                { role: 'system', type: 'message', content: [{ type: 'input_text', text: 'sys' }] },
                { role: 'user', type: 'message', content: [{ type: 'input_text', text: 'hi' }] },
            ],
        };
        const result = converter.toOpenAIResponsesToCodexRequest(req);
        const hasSysMsg = result.input.some(m => m.role === 'system' || m.role === 'developer');
        expect(hasSysMsg).toBe(false);
    });

    test('includes reasoning.encrypted_content in include array', () => {
        const req = { model: 'o3', input: [] };
        const result = converter.toOpenAIResponsesToCodexRequest(req);
        expect(result.include).toContain('reasoning.encrypted_content');
    });
});

// ============================================================================
// CodexConverter.toOpenAIRequestToCodexRequest
// ============================================================================

describe('CodexConverter.toOpenAIRequestToCodexRequest', () => {
    const converter = new CodexConverter();

    test('system messages become instructions', () => {
        const req = {
            model: 'o3',
            messages: [
                { role: 'system', content: 'Be a helpful assistant.' },
                { role: 'user', content: 'Hello' },
            ],
        };
        const result = converter.toOpenAIRequestToCodexRequest(req);
        expect(result.instructions).toBe('Be a helpful assistant.');
    });

    test('user messages become input array', () => {
        const req = {
            model: 'o3',
            messages: [{ role: 'user', content: 'Hello' }],
        };
        const result = converter.toOpenAIRequestToCodexRequest(req);
        expect(Array.isArray(result.input)).toBe(true);
    });

    test('tools are converted via convertTools', () => {
        const req = {
            model: 'o3',
            messages: [],
            tools: [{ type: 'function', function: { name: 'myTool', description: 'Does things', parameters: {} } }],
        };
        const result = converter.toOpenAIRequestToCodexRequest(req);
        expect(Array.isArray(result.tools)).toBe(true);
        expect(result.tools[0].name).toBe('myTool');
    });

    test('stream is always true', () => {
        const req = { model: 'o3', messages: [], stream: false };
        const result = converter.toOpenAIRequestToCodexRequest(req);
        expect(result.stream).toBe(true);
    });
});

// ============================================================================
// CodexConverter.buildInstructions
// ============================================================================

describe('CodexConverter.buildInstructions', () => {
    const converter = new CodexConverter();

    test('returns explicit instructions field when present', () => {
        const data = { instructions: 'Do X', messages: [] };
        expect(converter.buildInstructions(data)).toBe('Do X');
    });

    test('extracts system messages as instructions', () => {
        const data = {
            messages: [
                { role: 'system', content: 'Be concise.' },
                { role: 'user', content: 'Hi' },
            ],
        };
        expect(converter.buildInstructions(data)).toBe('Be concise.');
    });

    test('returns empty string when no system message', () => {
        const data = { messages: [{ role: 'user', content: 'Hi' }] };
        expect(converter.buildInstructions(data)).toBe('');
    });
});

// ============================================================================
// CodexConverter.buildToolNameMap + shortenToolName
// ============================================================================

describe('CodexConverter.buildToolNameMap', () => {
    const converter = new CodexConverter();

    test('short names are stored as-is', () => {
        converter.buildToolNameMap([{ type: 'function', function: { name: 'myTool' } }]);
        expect(converter.toolNameMap.get('myTool')).toBe('myTool');
    });

    test('long mcp__ names are shortened', () => {
        const longName = 'mcp__some_server__' + 'a'.repeat(60);
        converter.buildToolNameMap([{ type: 'function', function: { name: longName } }]);
        const short = converter.toolNameMap.get(longName);
        expect(short.length).toBeLessThanOrEqual(64);
        expect(short.startsWith('mcp__')).toBe(true);
    });

    test('reverse lookup works', () => {
        converter.buildToolNameMap([{ type: 'function', function: { name: 'toolX' } }]);
        expect(converter.reverseToolNameMap.get('toolX')).toBe('toolX');
    });
});

// ============================================================================
// CodexConverter.toOpenAIResponse
// ============================================================================

describe('CodexConverter.toOpenAIResponse', () => {
    const converter = new CodexConverter();

    test('returns null for non-response.completed type', () => {
        const result = converter.toOpenAIResponse({ type: 'response.created' }, 'o3');
        expect(result).toBeNull();
    });

    test('response.completed is converted to chat.completion', () => {
        const raw = {
            type: 'response.completed',
            response: {
                id: 'resp-abc',
                model: 'o3',
                output: [
                    {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'Hello!' }],
                        role: 'assistant',
                    },
                ],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
        };
        const result = converter.toOpenAIResponse(raw, 'o3');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.content).toBe('Hello!');
        expect(result.usage.prompt_tokens).toBe(10);
    });
});

// ============================================================================
// Helper: build completed response fixture
// ============================================================================

function makeCodexCompleted(text = 'response text', model = 'o3') {
    return {
        type: 'response.completed',
        response: {
            id: 'resp-abc',
            model,
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text }],
                },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
    };
}

// ============================================================================
// CodexConverter.toOpenAIResponsesResponse
// ============================================================================

describe('CodexConverter.toOpenAIResponsesResponse', () => {
    const converter = new CodexConverter();

    test('returns null for non-response.completed type', () => {
        expect(converter.toOpenAIResponsesResponse({ type: 'response.created' }, 'o3')).toBeNull();
    });

    test('converts completed response to OpenAI Responses format', () => {
        const result = converter.toOpenAIResponsesResponse(makeCodexCompleted(), 'o3');
        expect(result.object).toBe('response');
        expect(result.status).toBe('completed');
        expect(result.output[0].content[0].type).toBe('output_text');
        expect(result.output[0].content[0].text).toBe('response text');
    });

    test('converts reasoning item in output', () => {
        const raw = {
            type: 'response.completed',
            response: {
                id: 'r1',
                model: 'o3',
                output: [{
                    type: 'reasoning',
                    summary: [{ type: 'summary_text', text: 'thinking...' }]
                }],
                usage: {},
            },
        };
        const result = converter.toOpenAIResponsesResponse(raw, 'o3');
        expect(result.output[0].content[0].type).toBe('reasoning');
    });
});

// ============================================================================
// CodexConverter.toGeminiResponse
// ============================================================================

describe('CodexConverter.toGeminiResponse', () => {
    const converter = new CodexConverter();

    test('returns null for non-completed type', () => {
        expect(converter.toGeminiResponse({ type: 'other' }, 'o3')).toBeNull();
    });

    test('converts completed response to Gemini format', () => {
        const result = converter.toGeminiResponse(makeCodexCompleted(), 'o3');
        expect(result.candidates).toBeDefined();
        expect(result.candidates[0].content.parts[0].text).toBe('response text');
    });
});

// ============================================================================
// CodexConverter.toClaudeResponse
// ============================================================================

describe('CodexConverter.toClaudeResponse', () => {
    const converter = new CodexConverter();

    test('returns null for non-completed type', () => {
        expect(converter.toClaudeResponse({ type: 'other' }, 'o3')).toBeNull();
    });

    test('converts completed response to Claude format', () => {
        const result = converter.toClaudeResponse(makeCodexCompleted(), 'o3');
        expect(result.type).toBe('message');
        expect(result.role).toBe('assistant');
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toBe('response text');
    });
});

// ============================================================================
// CodexConverter.toOpenAIStreamChunk
// ============================================================================

describe('CodexConverter.toOpenAIStreamChunk', () => {
    test('response.created returns null', () => {
        const converter = new CodexConverter();
        const chunk = { type: 'response.created', response: { id: 'r1', created_at: 1, model: 'o3' } };
        const result = converter.toOpenAIStreamChunk(chunk, 'o3');
        expect(result).toBeNull();
    });

    test('response.output_text.delta emits content chunk', () => {
        const converter = new CodexConverter();
        // Set up state by sending created first
        converter.toOpenAIStreamChunk(
            { type: 'response.created', response: { id: 'r1', created_at: 1, model: 'o3' } },
            'o3'
        );
        const chunk = { type: 'response.output_text.delta', delta: 'hello' };
        const result = converter.toOpenAIStreamChunk(chunk, 'o3');
        const chunks = Array.isArray(result) ? result : [result];
        const hasContent = chunks.some(c => c?.choices?.[0]?.delta?.content === 'hello');
        expect(hasContent).toBe(true);
    });

    test('response.completed emits finish chunk', () => {
        const converter = new CodexConverter();
        converter.toOpenAIStreamChunk(
            { type: 'response.created', response: { id: 'r1', created_at: 1, model: 'o3' } },
            'o3'
        );
        const chunk = {
            type: 'response.completed',
            response: {
                id: 'r1',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
            }
        };
        const result = converter.toOpenAIStreamChunk(chunk, 'o3');
        const chunks = Array.isArray(result) ? result : [result];
        const done = chunks.find(c => c?.choices?.[0]?.finish_reason === 'stop');
        expect(done).toBeDefined();
    });
});

// ============================================================================
// CodexConverter routing — additional protocols
// ============================================================================

describe('CodexConverter routing — additional protocols', () => {
    const completedResponse = makeCodexCompleted();

    test('convertResponse OPENAI_RESPONSES', () => {
        const converter = new CodexConverter();
        const result = converter.convertResponse(completedResponse, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'o3');
        expect(result.object).toBe('response');
    });

    test('convertResponse GEMINI', () => {
        const converter = new CodexConverter();
        const result = converter.convertResponse(completedResponse, MODEL_PROTOCOL_PREFIX.GEMINI, 'o3');
        expect(result.candidates).toBeDefined();
    });

    test('convertResponse CLAUDE', () => {
        const converter = new CodexConverter();
        const result = converter.convertResponse(completedResponse, MODEL_PROTOCOL_PREFIX.CLAUDE, 'o3');
        expect(result.type).toBe('message');
    });

    test('convertResponse CODEX returns data as-is', () => {
        const converter = new CodexConverter();
        expect(converter.convertResponse(completedResponse, MODEL_PROTOCOL_PREFIX.CODEX, 'o3')).toBe(completedResponse);
    });

    test('convertStreamChunk CODEX returns chunk as-is', () => {
        const converter = new CodexConverter();
        const chunk = { type: 'response.output_text.delta', delta: 'x' };
        expect(converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CODEX, 'o3')).toBe(chunk);
    });

    test('convertStreamChunk GEMINI', () => {
        const converter = new CodexConverter();
        const chunk = { type: 'response.output_text.delta', delta: 'x' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'o3');
        // May be null for intermediate chunks
        expect(result === null || typeof result === 'object').toBe(true);
    });

    test('convertStreamChunk OPENAI_RESPONSES', () => {
        const converter = new CodexConverter();
        const chunk = { type: 'response.output_text.delta', delta: 'x' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'o3');
        expect(result === null || typeof result === 'object').toBe(true);
    });

    test('convertStreamChunk CLAUDE', () => {
        const converter = new CodexConverter();
        const chunk = { type: 'response.output_text.delta', delta: 'x' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'o3', 'req-1');
        expect(result === null || typeof result === 'object').toBe(true);
    });
});
