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
    test('converts Gemini search tool to OpenAI with normalized args', async () => {
        const converter = new GeminiConverter();
        // Test that the stream chunk conversion handles function calls properly
        const geminiChunk = {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                functionCall: {
                                    name: 'search',
                                    args: { query: 'test query' },
                                },
                            },
                        ],
                    },
                },
            ],
        };
        const result = converter.convertStreamChunk(geminiChunk, MODEL_PROTOCOL_PREFIX.OPENAI, 'gemini-pro');
        expect(result.choices[0].delta.tool_calls[0].function.name).toBe('search');
    });
});
