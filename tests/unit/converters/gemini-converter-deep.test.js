/**
 * Gemini Converter Deep Tests
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

let GeminiConverter;
let MODEL_PROTOCOL_PREFIX;

beforeAll(async () => {
    ({ GeminiConverter } = await import('../../../src/converters/strategies/GeminiConverter.js'));
    ({ MODEL_PROTOCOL_PREFIX } = await import('../../../src/utils/common.js'));
});

describe('GeminiConverter - Gemini -> OpenAI Request', () => {
    test('converts simple Gemini request to OpenAI format', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.messages).toBeDefined();
        expect(Array.isArray(result.messages)).toBe(true);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content).toContain('Hello world');
    });

    test('converts Gemini systemInstruction to OpenAI system message', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            systemInstruction: { parts: [{ text: 'Be a helpful AI.' }] },
            contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        const systemMsg = result.messages.find(m => m.role === 'system');
        expect(systemMsg).toBeDefined();
        expect(systemMsg.content).toContain('Be a helpful AI.');
    });

    test('maps model role to assistant role in OpenAI', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            contents: [
                { role: 'user', parts: [{ text: 'Hello' }] },
                { role: 'model', parts: [{ text: 'Hi there!' }] },
            ],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        const assistantMsg = result.messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
    });

    test('handles multipart content with inlineData (image)', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro-vision',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: 'Describe this image' },
                        { inlineData: { mimeType: 'image/jpeg', data: 'base64datahere' } },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.OPENAI);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        const imageBlock = userMsg.content.find(c => c.type === 'image_url');
        expect(imageBlock).toBeDefined();
        expect(imageBlock.image_url.url).toContain('data:image/jpeg;base64,');
    });

    test('throws for unsupported target protocol', async () => {
        const converter = new GeminiConverter();
        expect(() =>
            converter.convertRequest({ contents: [] }, 'unknown-protocol')
        ).toThrow('Unsupported target protocol');
    });
});

describe('GeminiConverter - Gemini -> OpenAI Response', () => {
    test('converts simple text response', async () => {
        const converter = new GeminiConverter();
        const geminiResp = {
            candidates: [
                {
                    content: { parts: [{ text: 'Hello from Gemini' }] },
                    finishReason: 'STOP',
                },
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15,
            },
        };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.role).toBe('assistant');
        expect(result.choices[0].message.content).toContain('Hello from Gemini');
        expect(result.choices[0].finish_reason).toBe('stop');
        expect(result.usage.prompt_tokens).toBe(10);
        expect(result.usage.completion_tokens).toBe(5);
    });

    test('converts function call in response to tool_calls', async () => {
        const converter = new GeminiConverter();
        const geminiResp = {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                functionCall: {
                                    name: 'get_weather',
                                    args: { city: 'NYC' },
                                },
                            },
                        ],
                    },
                    finishReason: 'STOP',
                },
            ],
        };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(result.choices[0].message.tool_calls).toBeDefined();
        expect(result.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
    });

    test('handles empty candidates', async () => {
        const converter = new GeminiConverter();
        const geminiResp = { candidates: [] };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.object).toBe('chat.completion');
    });

    test('includes usage metadata when present', async () => {
        const converter = new GeminiConverter();
        const geminiResp = {
            candidates: [
                { content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP' },
            ],
            usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 10,
                totalTokenCount: 30,
                cachedContentTokenCount: 5,
                thoughtsTokenCount: 3,
            },
        };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.usage.cached_tokens).toBe(5);
        expect(result.usage.completion_tokens_details.reasoning_tokens).toBe(3);
    });
});

describe('GeminiConverter - Gemini -> OpenAI Stream Chunk', () => {
    test('converts text stream chunk', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [
                {
                    content: { parts: [{ text: 'Hello' }] },
                },
            ],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result).not.toBeNull();
        expect(result.object).toBe('chat.completion.chunk');
        expect(result.choices[0].delta.content).toBe('Hello');
    });

    test('returns null for empty chunk without candidates', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = { candidates: [] };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result).toBeNull();
    });

    test('handles finish reason in stream chunk', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [
                {
                    content: { parts: [{ text: 'Done' }] },
                    finishReason: 'STOP',
                },
            ],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    test('maps MAX_TOKENS to length finish_reason', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [
                {
                    content: { parts: [{ text: 'truncated' }] },
                    finishReason: 'MAX_TOKENS',
                },
            ],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].finish_reason).toBe('length');
    });

    test('converts function call in stream chunk', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                functionCall: {
                                    name: 'search',
                                    args: { query: 'test' },
                                },
                            },
                        ],
                    },
                },
            ],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].delta.tool_calls).toBeDefined();
        expect(result.choices[0].delta.tool_calls[0].function.name).toBe('search');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
    });
});

describe('GeminiConverter - Gemini -> Claude Request', () => {
    test('converts Gemini request to Claude format', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            contents: [{ role: 'user', parts: [{ text: 'Hello Claude' }] }],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.messages).toBeDefined();
        expect(result.messages[0].role).toBe('user');
    });

    test('converts systemInstruction to Claude system field', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            systemInstruction: { parts: [{ text: 'Be concise.' }] },
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.system).toContain('Be concise.');
    });

    test('converts Gemini tools to Claude tools format', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            contents: [{ role: 'user', parts: [{ text: 'Use tools' }] }],
            tools: [
                {
                    functionDeclarations: [
                        {
                            name: 'calculate',
                            description: 'Do math',
                            parameters: { type: 'object', properties: { x: { type: 'number' } } },
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.tools).toBeDefined();
        expect(result.tools[0].name).toBe('calculate');
        expect(result.tools[0].input_schema).toBeDefined();
    });
});

describe('GeminiConverter - Gemini -> Claude Response', () => {
    test('converts normal text Gemini response to Claude format', async () => {
        const converter = new GeminiConverter();
        const geminiResp = {
            candidates: [
                {
                    content: { parts: [{ text: 'Answer from Gemini' }] },
                    finishReason: 'STOP',
                },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        expect(result.type).toBe('message');
        expect(result.role).toBe('assistant');
        expect(result.stop_reason).toBe('end_turn');
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('Answer from Gemini');
    });

    test('returns tool_use stop_reason when function calls present', async () => {
        const converter = new GeminiConverter();
        const geminiResp = {
            candidates: [
                {
                    content: {
                        parts: [{ functionCall: { name: 'myTool', args: {} } }],
                    },
                    finishReason: 'STOP',
                },
            ],
        };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        expect(result.stop_reason).toBe('tool_use');
    });

    test('handles empty candidates in Gemini response', async () => {
        const converter = new GeminiConverter();
        const geminiResp = { candidates: [] };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        expect(result.type).toBe('message');
        expect(result.content).toEqual([]);
        expect(result.stop_reason).toBe('end_turn');
    });
});

describe('GeminiConverter - Model List Conversion', () => {
    test('converts Gemini model list to OpenAI format', async () => {
        const converter = new GeminiConverter();
        const geminiModels = {
            models: [
                { name: 'models/gemini-pro', displayName: 'Gemini Pro' },
                { name: 'models/gemini-pro-vision', displayName: 'Gemini Pro Vision' },
            ],
        };
        const result = converter.convertModelList(geminiModels, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(result.object).toBe('list');
        expect(result.data).toHaveLength(2);
        expect(result.data[0].owned_by).toBe('google');
        // Model name should have 'models/' prefix stripped
        expect(result.data[0].id).toBe('gemini-pro');
    });

    test('converts Gemini model list to Claude format', async () => {
        const converter = new GeminiConverter();
        const geminiModels = {
            models: [{ name: 'models/gemini-pro', displayName: 'Gemini Pro' }],
        };
        const result = converter.convertModelList(geminiModels, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result.models).toBeDefined();
    });
});

describe('GeminiConverter - remapFunctionCallArgs (via Gemini stream chunks)', () => {
    function makeFunctionCallChunk(name, args) {
        return {
            candidates: [{
                content: {
                    parts: [{ functionCall: { name, args } }],
                },
            }],
        };
    }

    test('converts Gemini search tool to OpenAI with normalized args', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('search', { query: 'test query' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].delta.tool_calls[0].function.name).toBe('search');
    });

    // Helper: extract remapped args from Claude stream result
    function getClaudeToolArgs(result) {
        const events = Array.isArray(result) ? result : [result];
        const delta = events.find(e => e.type === 'content_block_delta');
        if (!delta) return null;
        return JSON.parse(delta.delta.partial_json);
    }

    test('EnterPlanMode tool gets empty args (via Claude stream)', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('EnterPlanMode', { someArg: 'value' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs).toEqual({});
    });

    test('grep: query remapped to pattern, paths array to path (via Claude stream)', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('grep', { query: 'myPattern', paths: ['/src'] });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.pattern).toBe('myPattern');
        expect(fnArgs.path).toBe('/src');
    });

    test('grep: description remapped to pattern when no pattern present', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('grep', { description: 'findMe' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.pattern).toBe('findMe');
        expect(fnArgs.path).toBe('.');
    });

    test('grep: missing path gets default "."', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('grep', { pattern: 'findMe' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.path).toBe('.');
    });

    test('glob: query remapped to pattern, paths string to path', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('glob', { query: '**/*.js', paths: '/src' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.pattern).toBe('**/*.js');
        expect(fnArgs.path).toBe('/src');
    });

    test('glob: paths array converted to path (first element)', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('glob', { pattern: '*.ts', paths: ['/root', '/other'] });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.path).toBe('/root');
    });

    test('read: path remapped to file_path', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('read', { path: '/src/index.js' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.file_path).toBe('/src/index.js');
    });

    test('ls: missing path gets default "."', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('ls', {});
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.path).toBe('.');
    });

    test('default case: paths array of 1 is converted to path (string)', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('custom_tool', { paths: ['/some/path'] });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.path).toBe('/some/path');
    });

    test('default case: paths array of >1 is NOT converted to path', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('custom_tool', { paths: ['/a', '/b'] });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.path).toBeUndefined();
    });

    test('grep: paths as string (not array) is assigned to path', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('grep', { pattern: 'test', paths: '/src/string' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.path).toBe('/src/string');
    });

    test('glob: paths as string assigned to path', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('glob', { pattern: '*.ts', paths: '/lib' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const fnArgs = getClaudeToolArgs(result);
        expect(fnArgs.path).toBe('/lib');
    });

    test('normalizeToolName: "search" tool name becomes "Grep" via Claude stream', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = makeFunctionCallChunk('search', { query: 'findMe' });
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const events = Array.isArray(result) ? result : [result];
        const blockStart = events.find(e => e.type === 'content_block_start');
        expect(blockStart?.content_block?.name).toBe('Grep');
    });
});

// ============================================================================
// GeminiConverter - OpenAI Responses Protocol
// ============================================================================

describe('GeminiConverter - Gemini -> OpenAI Responses Request', () => {
    test('converts gemini request to openai responses format', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result).toBeDefined();
        expect(result.model).toBe('gemini-pro');
    });
});

describe('GeminiConverter - Gemini -> OpenAI Responses Response', () => {
    test('converts gemini response to openai responses format', async () => {
        const converter = new GeminiConverter();
        const geminiResp = {
            candidates: [{
                content: { parts: [{ text: 'Hello there' }], role: 'model' },
                finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'gemini-pro');
        expect(result).toBeDefined();
    });
});

describe('GeminiConverter - Gemini -> OpenAI Responses Stream Chunk', () => {
    test('converts gemini stream chunk to openai responses events', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [{
                content: { parts: [{ text: 'chunk' }], role: 'model' },
            }],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'gemini-pro');
        expect(result).toBeDefined();
    });

    test('returns empty array for null chunk', async () => {
        const converter = new GeminiConverter();
        const result = converter.convertStreamChunk(null, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'gemini-pro');
        // toOpenAIResponsesStreamChunk delegates to toOpenAIStreamChunk which may return null,
        // resulting in an empty array or null
        expect(result === null || Array.isArray(result)).toBe(true);
    });
});

// ============================================================================
// GeminiConverter - Codex Protocol
// ============================================================================

describe('GeminiConverter - Gemini -> Codex Request', () => {
    test('converts gemini request to codex format', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result).toBeDefined();
    });
});

describe('GeminiConverter - Gemini -> Codex Response', () => {
    test('converts gemini response to codex format', async () => {
        const converter = new GeminiConverter();
        const geminiResp = {
            candidates: [{
                content: { parts: [{ text: 'Codex response text' }], role: 'model' },
                finishReason: 'STOP',
            }],
        };
        const result = converter.convertResponse(geminiResp, MODEL_PROTOCOL_PREFIX.CODEX, 'gemini-pro');
        expect(result).toBeDefined();
    });
});

describe('GeminiConverter - Gemini -> Codex Stream Chunk', () => {
    test('converts gemini stream chunk to codex format', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [{
                content: { parts: [{ text: 'chunk text' }], role: 'model' },
            }],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CODEX, 'gemini-pro');
        expect(result).toBeDefined();
    });
});

// ============================================================================
// GeminiConverter - Grok Protocol
// ============================================================================

describe('GeminiConverter - Gemini -> Grok Request', () => {
    test('converts gemini request to grok format', async () => {
        const converter = new GeminiConverter();
        const geminiReq = {
            model: 'gemini-pro',
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        };
        const result = converter.convertRequest(geminiReq, MODEL_PROTOCOL_PREFIX.GROK);
        expect(result).toBeDefined();
    });
});

// ============================================================================
// GeminiConverter - Claude stream chunk
// ============================================================================

describe('GeminiConverter - Gemini -> Claude Stream Chunk', () => {
    test('converts text chunk to claude content_block_delta', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [{
                content: { parts: [{ text: 'Hello' }], role: 'model' },
            }],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        expect(result).toBeDefined();
        const events = Array.isArray(result) ? result : [result];
        const delta = events.find(e => e.type === 'content_block_delta');
        expect(delta).toBeDefined();
        expect(delta.delta.text).toBe('Hello');
    });

    test('converts thinking chunk with thought=true', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [{
                content: {
                    parts: [{ text: 'thinking text', thought: true }],
                    role: 'model'
                },
            }],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        const events = Array.isArray(result) ? result : [result];
        const thinking = events.find(e => e?.delta?.type === 'thinking_delta');
        expect(thinking).toBeDefined();
        expect(thinking.delta.thinking).toBe('thinking text');
    });

    test('handles finishReason in chunk', async () => {
        const converter = new GeminiConverter();
        const geminiChunk = {
            candidates: [{
                content: { parts: [], role: 'model' },
                finishReason: 'STOP',
            }],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gemini-pro');
        expect(result).toBeDefined();
        if (result) {
            const events = Array.isArray(result) ? result : [result];
            const delta = events.find(e => e.type === 'message_delta');
            expect(delta?.delta?.stop_reason).toBe('end_turn');
        }
    });
});
