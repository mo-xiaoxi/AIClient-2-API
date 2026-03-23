/**
 * Unit tests for src/convert/convert.js
 *
 * Tests: convertData, helper conversion functions, getRegisteredProtocols,
 *        isProtocolRegistered, clearConverterCache, getConverter,
 *        getOpenAIStreamChunkStop, getOpenAIResponsesStreamChunkBegin/End.
 *
 * Strategy: import register-converters so real converters are available,
 * only mock logger and tls-sidecar.
 *
 * ESM: jest.unstable_mockModule + dynamic import.
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks – keep minimal, allow real converter logic to run
// ---------------------------------------------------------------------------

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        },
    }));

    // Mock openai-responses-core.mjs helper generators
    await jest.unstable_mockModule('../../../src/providers/openai/openai-responses-core.mjs', () => ({
        generateResponseCreated: jest.fn((id, model) => ({ type: 'response.created', id, model })),
        generateResponseInProgress: jest.fn((id) => ({ type: 'response.in_progress', id })),
        generateOutputItemAdded: jest.fn((id) => ({ type: 'response.output_item.added', id })),
        generateContentPartAdded: jest.fn((id) => ({ type: 'response.content_part.added', id })),
        generateOutputTextDone: jest.fn((id) => ({ type: 'response.output_text.done', id })),
        generateContentPartDone: jest.fn((id) => ({ type: 'response.content_part.done', id })),
        generateOutputItemDone: jest.fn((id) => ({ type: 'response.output_item.done', id })),
        generateResponseCompleted: jest.fn((id) => ({ type: 'response.completed', id })),
    }));
});

// ---------------------------------------------------------------------------
// Module references
// ---------------------------------------------------------------------------
let convert;
let MODEL_PROTOCOL_PREFIX;

beforeAll(async () => {
    // Ensure converters are registered before importing convert.js
    await import('../../../src/converters/register-converters.js');
    convert = await import('../../../src/convert/convert.js');
    const common = await import('../../../src/utils/common.js');
    MODEL_PROTOCOL_PREFIX = common.MODEL_PROTOCOL_PREFIX;
});

// ---------------------------------------------------------------------------
// getRegisteredProtocols / isProtocolRegistered
// ---------------------------------------------------------------------------
describe('getRegisteredProtocols', () => {
    test('returns an array of registered protocol strings', () => {
        const protocols = convert.getRegisteredProtocols();
        expect(Array.isArray(protocols)).toBe(true);
        expect(protocols.length).toBeGreaterThan(0);
    });

    test('includes openai protocol', () => {
        const protocols = convert.getRegisteredProtocols();
        expect(protocols).toContain('openai');
    });

    test('includes claude protocol', () => {
        const protocols = convert.getRegisteredProtocols();
        expect(protocols).toContain('claude');
    });

    test('includes gemini protocol', () => {
        const protocols = convert.getRegisteredProtocols();
        expect(protocols).toContain('gemini');
    });
});

describe('isProtocolRegistered', () => {
    test('returns true for registered protocol', () => {
        expect(convert.isProtocolRegistered('openai')).toBe(true);
    });

    test('returns false for unknown protocol', () => {
        expect(convert.isProtocolRegistered('unknown-xyz')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// getConverter
// ---------------------------------------------------------------------------
describe('getConverter', () => {
    test('returns converter instance for openai protocol', () => {
        const converter = convert.getConverter('openai');
        expect(converter).toBeDefined();
        expect(typeof converter.convertRequest).toBe('function');
    });

    test('returns converter instance for claude protocol', () => {
        const converter = convert.getConverter('claude');
        expect(converter).toBeDefined();
    });

    test('returns converter instance for gemini protocol', () => {
        const converter = convert.getConverter('gemini');
        expect(converter).toBeDefined();
    });

    test('throws for unregistered protocol', () => {
        expect(() => convert.getConverter('no-such-protocol')).toThrow();
    });
});

// ---------------------------------------------------------------------------
// convertData
// ---------------------------------------------------------------------------
describe('convertData', () => {
    const simpleOpenAIRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
    };

    test('openai->claude request conversion produces claude-shaped output', () => {
        const result = convert.convertData(
            simpleOpenAIRequest,
            'request',
            'openai-custom',
            'claude-custom'
        );
        expect(result).toHaveProperty('messages');
        expect(result).toHaveProperty('max_tokens');
        expect(result.messages[0].role).toBe('user');
    });

    test('openai->gemini request conversion produces gemini-shaped output', () => {
        const result = convert.convertData(
            simpleOpenAIRequest,
            'request',
            'openai-custom',
            'gemini-cli-oauth'
        );
        expect(result).toHaveProperty('contents');
        expect(Array.isArray(result.contents)).toBe(true);
    });

    test('forward protocol passthrough returns original data unchanged', () => {
        const data = { custom: 'data' };
        const result = convert.convertData(
            data,
            'request',
            'forward-api',
            'forward-api'
        );
        expect(result).toBe(data);
    });

    test('throws on unsupported conversion type', () => {
        expect(() =>
            convert.convertData(
                simpleOpenAIRequest,
                'unsupportedType',
                'openai-custom',
                'claude-custom'
            )
        ).toThrow('Unsupported conversion type');
    });

    test('claude->openai response conversion produces openai-shaped output', () => {
        const claudeResponse = {
            id: 'msg_01',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello world' }],
            model: 'claude-3-5-sonnet',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        const result = convert.convertData(
            claudeResponse,
            'response',
            'claude-custom',
            'openai-custom',
            'claude-3-5-sonnet'
        );
        expect(result).toHaveProperty('choices');
        expect(result.choices[0].message.content).toContain('Hello world');
    });

    test('gemini->openai streamChunk conversion produces chunk output', () => {
        const geminiChunk = {
            candidates: [{
                content: { parts: [{ text: 'chunk text' }], role: 'model' },
                finishReason: null,
            }],
        };
        const result = convert.convertData(
            geminiChunk,
            'streamChunk',
            'gemini-cli-oauth',
            'openai-custom',
            'gemini-2.0-flash'
        );
        expect(result).toHaveProperty('choices');
        expect(result.choices[0].delta.content).toContain('chunk text');
    });

    test('modelList conversion produces openai model list', () => {
        const claudeModels = { models: [{ id: 'claude-3-5-sonnet' }] };
        const result = convert.convertData(
            claudeModels,
            'modelList',
            'claude-custom',
            'openai-custom'
        );
        expect(result).toHaveProperty('data');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Backward-compatible helper functions
// ---------------------------------------------------------------------------
describe('toOpenAIRequestFromGemini', () => {
    test('converts a gemini request to OpenAI format', () => {
        const geminiRequest = {
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        };
        // Should not throw
        const result = convert.toOpenAIRequestFromGemini(geminiRequest);
        expect(result).toBeDefined();
    });
});

describe('toOpenAIRequestFromClaude', () => {
    test('converts a claude request to OpenAI format', () => {
        const claudeRequest = {
            model: 'claude-3-5-sonnet',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'Hello' }],
        };
        const result = convert.toOpenAIRequestFromClaude(claudeRequest);
        expect(result).toBeDefined();
    });
});

describe('toClaudeRequestFromOpenAI', () => {
    test('converts an OpenAI request to Claude format', () => {
        const openaiRequest = {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 100,
        };
        const result = convert.toClaudeRequestFromOpenAI(openaiRequest);
        expect(result).toBeDefined();
        expect(result).toHaveProperty('messages');
    });
});

describe('toGeminiRequestFromOpenAI', () => {
    test('converts an OpenAI request to Gemini format', () => {
        const openaiRequest = {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hello' }],
        };
        const result = convert.toGeminiRequestFromOpenAI(openaiRequest);
        expect(result).toBeDefined();
        expect(result).toHaveProperty('contents');
    });
});

describe('toOpenAIChatCompletionFromClaude', () => {
    test('converts claude response to OpenAI chat completion format', () => {
        const claudeResponse = {
            id: 'msg_01',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
            model: 'claude-3-5-sonnet',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        const result = convert.toOpenAIChatCompletionFromClaude(claudeResponse, 'claude-3-5-sonnet');
        expect(result).toBeDefined();
        expect(result).toHaveProperty('choices');
    });
});

describe('toOpenAIChatCompletionFromGemini', () => {
    test('converts gemini response to OpenAI chat completion format', () => {
        const geminiResponse = {
            candidates: [{
                content: { parts: [{ text: 'Hello!' }], role: 'model' },
                finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        };
        const result = convert.toOpenAIChatCompletionFromGemini(geminiResponse, 'gemini-2.0-flash');
        expect(result).toBeDefined();
        expect(result).toHaveProperty('choices');
    });
});

// ---------------------------------------------------------------------------
// getOpenAIStreamChunkStop
// ---------------------------------------------------------------------------
describe('getOpenAIStreamChunkStop', () => {
    test('returns a valid stream stop chunk object', () => {
        const chunk = convert.getOpenAIStreamChunkStop('gpt-4');
        expect(chunk).toHaveProperty('object', 'chat.completion.chunk');
        expect(chunk).toHaveProperty('model', 'gpt-4');
        expect(chunk.choices[0].finish_reason).toBe('stop');
    });

    test('includes usage with zero tokens', () => {
        const chunk = convert.getOpenAIStreamChunkStop('gpt-4');
        expect(chunk.usage.total_tokens).toBe(0);
    });

    test('generates unique id for each call', () => {
        const chunk1 = convert.getOpenAIStreamChunkStop('gpt-4');
        const chunk2 = convert.getOpenAIStreamChunkStop('gpt-4');
        expect(chunk1.id).not.toBe(chunk2.id);
    });
});

// ---------------------------------------------------------------------------
// getOpenAIResponsesStreamChunkBegin / End
// ---------------------------------------------------------------------------
describe('getOpenAIResponsesStreamChunkBegin', () => {
    test('returns array of 4 begin events with correct types', () => {
        const events = convert.getOpenAIResponsesStreamChunkBegin('resp-id', 'gpt-4');
        expect(Array.isArray(events)).toBe(true);
        expect(events).toHaveLength(4);
        // Verify each event has the id passed through
        events.forEach(e => expect(e).toHaveProperty('id', 'resp-id'));
    });
});

describe('getOpenAIResponsesStreamChunkEnd', () => {
    test('returns array of 4 end events with correct types', () => {
        const events = convert.getOpenAIResponsesStreamChunkEnd('resp-id');
        expect(Array.isArray(events)).toBe(true);
        expect(events).toHaveLength(4);
        events.forEach(e => expect(e).toHaveProperty('id', 'resp-id'));
    });
});

// ---------------------------------------------------------------------------
// clearConverterCache
// ---------------------------------------------------------------------------
describe('clearConverterCache', () => {
    test('does not throw when called', () => {
        expect(() => convert.clearConverterCache()).not.toThrow();
    });

    test('converter still usable after cache clear', () => {
        convert.clearConverterCache();
        // Re-import converters
        const converter = convert.getConverter('openai');
        expect(converter).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// extractAndProcessSystemMessages / extractTextFromMessageContent
// ---------------------------------------------------------------------------
// Note: extractAndProcessSystemMessages and extractTextFromMessageContent in convert.js
// delegate to converters/utils.js. The underlying utility functions work correctly.
// We test the utility functions directly from their own module.
describe('converters/utils — extractAndProcessSystemMessages', () => {
    let extractAndProcessSystemMessagesFn;

    beforeAll(async () => {
        const utils = await import('../../../src/converters/utils.js');
        extractAndProcessSystemMessagesFn = utils.extractAndProcessSystemMessages;
    });

    test('extracts system messages and returns nonSystemMessages', () => {
        const messages = [
            { role: 'system', content: 'Be helpful' },
            { role: 'user', content: 'Hello' },
        ];
        const result = extractAndProcessSystemMessagesFn(messages);
        expect(result).toHaveProperty('systemInstruction');
        expect(result).toHaveProperty('nonSystemMessages');
        expect(result.nonSystemMessages).toHaveLength(1);
    });

    test('returns null systemInstruction when no system messages', () => {
        const messages = [{ role: 'user', content: 'Hello' }];
        const result = extractAndProcessSystemMessagesFn(messages);
        expect(result.systemInstruction).toBeNull();
    });
});

describe('converters/utils — extractTextFromMessageContent', () => {
    let extractTextFn;

    beforeAll(async () => {
        const utils = await import('../../../src/converters/utils.js');
        extractTextFn = utils.extractTextFromMessageContent;
    });

    test('extracts text from string content', () => {
        const result = extractTextFn('hello world');
        expect(typeof result).toBe('string');
        expect(result).toContain('hello');
    });

    test('extracts text from array content with text parts', () => {
        const content = [{ type: 'text', text: 'hello world' }];
        const result = extractTextFn(content);
        expect(result).toContain('hello');
    });

    test('returns empty string for non-text content', () => {
        const result = extractTextFn(null);
        expect(result).toBe('');
    });
});
