/**
 * ClaudeConverter extra tests — covers branches not reached by existing test files.
 *
 * Targets (uncovered lines):
 *   1293-1317  thinking_delta / signature_delta / input_json_delta in Gemini stream
 *   1356-1367  backward-compat string chunk
 *   1375-1446  processClaudeContentToGeminiParts
 *   1451-1475  buildGeminiToolConfigFromClaude
 *   1499-1601  toOpenAIResponsesRequest — system array, thinking, tool_result/tool_use/image, tools, tool_choice
 *   1683-1795  toOpenAIResponsesStreamChunk
 *   1807-1891  _shortenNameIfNeeded, _buildShortNameMap, _normalizeToolParameters
 *   1914-1984  toCodexRequest — system / tools
 *   2022-2073  toCodexRequest message content blocks + thinking
 *   2080-2085  toCodexRequest CODEX_INSTRUCTIONS_ENABLED
 *    931-987   toGeminiRequest tool_result content block
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

let ClaudeConverter;
let MODEL_PROTOCOL_PREFIX;

beforeAll(async () => {
    ({ ClaudeConverter } = await import('../../../src/converters/strategies/ClaudeConverter.js'));
    ({ MODEL_PROTOCOL_PREFIX } = await import('../../../src/utils/common.js'));
});

// =============================================================================
// toGeminiRequest — tool_result content block (lines 931-987)
// =============================================================================

describe('ClaudeConverter.toGeminiRequest — tool_result block', () => {
    test('tool_result with toolu_ prefix uses id as funcName', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: 'use tool' },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_abc123',
                            content: 'result text',
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        const parts = result.contents.find(c => c.parts?.some(p => p.functionResponse));
        expect(parts).toBeDefined();
        expect(parts.parts[0].functionResponse.name).toBe('toolu_abc123');
    });

    test('tool_result with hyphenated id extracts function name', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: 'use tool' },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'my_fn-uuid1234',
                            content: 'some result',
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        const parts = result.contents.find(c => c.parts?.some(p => p.functionResponse));
        expect(parts).toBeDefined();
        expect(parts.parts[0].functionResponse.name).toBe('my_fn');
    });

    test('tool_result with array content extracts text parts', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: 'x' },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'fn-id',
                            content: [
                                { type: 'text', text: 'line1' },
                                { type: 'text', text: 'line2' },
                            ],
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        const parts = result.contents.find(c => c.parts?.some(p => p.functionResponse));
        expect(parts.parts[0].functionResponse.response.result).toContain('line1');
    });

    test('tool_result with object content JSON-stringifies it', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: 'x' },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'obj-fn-id',
                            content: { key: 'value' },
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        const parts = result.contents.find(c => c.parts?.some(p => p.functionResponse));
        expect(parts.parts[0].functionResponse.response.result).toContain('key');
    });

    test('tool_result with image block in content array handles non-text', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: 'x' },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'img-fn-id',
                            content: [{ type: 'image', source: {} }],
                        },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.GEMINI);
        // non-text parts → textParts empty → JSON.stringify fallback
        const parts = result.contents.find(c => c.parts?.some(p => p.functionResponse));
        expect(parts.parts[0].functionResponse.response.result).toBeDefined();
    });
});

// =============================================================================
// Gemini stream: thinking_delta, signature_delta, input_json_delta (lines 1293-1317)
// =============================================================================

describe('ClaudeConverter.toGeminiStreamChunk — extra delta types', () => {
    test('thinking_delta returns thought part', () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'I am thinking' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'gemini-pro');
        expect(result).not.toBeNull();
        expect(result.candidates[0].content.parts[0].thought).toBe(true);
        expect(result.candidates[0].content.parts[0].text).toBe('I am thinking');
    });

    test('signature_delta returns null', () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            delta: { type: 'signature_delta', signature: 'sig' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'gemini-pro');
        expect(result).toBeNull();
    });

    test('input_json_delta returns null', () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"k":' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.GEMINI, 'gemini-pro');
        expect(result).toBeNull();
    });

    test('backward-compat: string chunk returns candidates with text', () => {
        const converter = new ClaudeConverter();
        const result = converter.convertStreamChunk('hello world', MODEL_PROTOCOL_PREFIX.GEMINI, 'gemini-pro');
        expect(result).not.toBeNull();
        expect(result.candidates[0].content.parts[0].text).toBe('hello world');
    });
});

// =============================================================================
// processClaudeContentToGeminiParts (lines 1375-1446)
// =============================================================================

describe('ClaudeConverter.processClaudeContentToGeminiParts', () => {
    test('null input returns empty array', () => {
        const converter = new ClaudeConverter();
        expect(converter.processClaudeContentToGeminiParts(null)).toEqual([]);
    });

    test('string input returns text part', () => {
        const converter = new ClaudeConverter();
        expect(converter.processClaudeContentToGeminiParts('hello')).toEqual([{ text: 'hello' }]);
    });

    test('array with text block returns text part', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([{ type: 'text', text: 'hi' }]);
        expect(result).toEqual([{ text: 'hi' }]);
    });

    test('array with image block (base64) returns inlineData part', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ]);
        expect(result[0].inlineData.mimeType).toBe('image/png');
        expect(result[0].inlineData.data).toBe('abc123');
    });

    test('array with image block (non-base64) is skipped', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([
            { type: 'image', source: { type: 'url', url: 'http://x.com/img.png' } },
        ]);
        expect(result).toEqual([]);
    });

    test('array with tool_use block returns functionCall part', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([
            { type: 'tool_use', name: 'my_fn', input: { x: 1 } },
        ]);
        expect(result[0].functionCall.name).toBe('my_fn');
        expect(result[0].functionCall.args).toEqual({ x: 1 });
    });

    test('array with tool_use block missing name is skipped', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([
            { type: 'tool_use', input: { x: 1 } },
        ]);
        expect(result).toEqual([]);
    });

    test('array with tool_result block returns functionResponse part', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([
            { type: 'tool_result', tool_use_id: 'fn_id', content: 'ok' },
        ]);
        expect(result[0].functionResponse.name).toBe('fn_id');
        expect(result[0].functionResponse.response.content).toBe('ok');
    });

    test('array with invalid block (no type) is skipped via warn', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([{ no_type: true }]);
        expect(result).toEqual([]);
    });

    test('array with null block is skipped', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([null]);
        expect(result).toEqual([]);
    });

    test('array with unknown type falls through to text fallback', () => {
        const converter = new ClaudeConverter();
        const result = converter.processClaudeContentToGeminiParts([
            { type: 'unknown_type', text: 'fallback text' },
        ]);
        expect(result[0].text).toBe('fallback text');
    });

    test('non-array non-string returns empty array', () => {
        const converter = new ClaudeConverter();
        expect(converter.processClaudeContentToGeminiParts(42)).toEqual([]);
    });
});

// =============================================================================
// buildGeminiToolConfigFromClaude (lines 1451-1475)
// =============================================================================

describe('ClaudeConverter.buildGeminiToolConfigFromClaude', () => {
    test('null input returns undefined with warn', () => {
        const converter = new ClaudeConverter();
        expect(converter.buildGeminiToolConfigFromClaude(null)).toBeUndefined();
    });

    test('missing type returns undefined', () => {
        const converter = new ClaudeConverter();
        expect(converter.buildGeminiToolConfigFromClaude({ noType: true })).toBeUndefined();
    });

    test('type=auto returns AUTO mode', () => {
        const converter = new ClaudeConverter();
        const result = converter.buildGeminiToolConfigFromClaude({ type: 'auto' });
        expect(result.functionCallingConfig.mode).toBe('AUTO');
    });

    test('type=none returns NONE mode', () => {
        const converter = new ClaudeConverter();
        const result = converter.buildGeminiToolConfigFromClaude({ type: 'none' });
        expect(result.functionCallingConfig.mode).toBe('NONE');
    });

    test('type=tool with name returns ANY mode with allowedFunctionNames', () => {
        const converter = new ClaudeConverter();
        const result = converter.buildGeminiToolConfigFromClaude({ type: 'tool', name: 'my_fn' });
        expect(result.functionCallingConfig.mode).toBe('ANY');
        expect(result.functionCallingConfig.allowedFunctionNames).toContain('my_fn');
    });

    test('type=tool without name returns undefined', () => {
        const converter = new ClaudeConverter();
        const result = converter.buildGeminiToolConfigFromClaude({ type: 'tool' });
        expect(result).toBeUndefined();
    });

    test('unknown type returns undefined', () => {
        const converter = new ClaudeConverter();
        const result = converter.buildGeminiToolConfigFromClaude({ type: 'exotic' });
        expect(result).toBeUndefined();
    });
});

// =============================================================================
// toOpenAIResponsesRequest — extra branches (lines 1499-1601)
// =============================================================================

describe('ClaudeConverter.toOpenAIResponsesRequest — extra branches', () => {
    test('system as array is joined with newlines', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            system: [{ type: 'text', text: 'sys1' }, 'sys2'],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result.instructions).toContain('sys1');
        expect(result.instructions).toContain('sys2');
    });

    test('thinking enabled sets reasoning field', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'enabled', budget_tokens: 1024 },
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result.reasoning).toBeDefined();
        expect(result.reasoning.effort).toBeDefined();
    });

    test('content array with tool_result becomes function_call_output', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result.input[0].type).toBe('function_call_output');
        expect(result.input[0].call_id).toBe('call_1');
    });

    test('content array with tool_result object content is JSON-stringified', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'call_2', content: { key: 'val' } }],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result.input[0].output).toContain('key');
    });

    test('content array with tool_use becomes function_call', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'call_3', name: 'my_fn', input: { x: 1 } }],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result.input[0].type).toBe('function_call');
        expect(result.input[0].call_id).toBe('call_3');
        expect(result.input[0].arguments).toContain('x');
    });

    test('content array with image block becomes input_image', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image', source: { media_type: 'image/png', data: 'abc' } },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        const msg = result.input.find(i => i.type === 'message');
        expect(msg).toBeDefined();
        expect(msg.content[0].type).toBe('input_image');
    });

    test('assistant text content becomes output_text', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        const msg = result.input.find(i => i.type === 'message');
        expect(msg.content[0].type).toBe('output_text');
    });

    test('tools array is converted to function tools', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'fn1', description: 'does stuff', input_schema: { type: 'object', properties: {} } }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result.tools[0].type).toBe('function');
        expect(result.tools[0].name).toBe('fn1');
    });

    test('tool_choice any maps to required', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            tool_choice: { type: 'any' },
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result.tool_choice).toBe('required');
    });

    test('tool_choice specific tool maps to function object', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            tool_choice: { type: 'tool', name: 'my_fn' },
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(result.tool_choice.type).toBe('function');
        expect(result.tool_choice.function.name).toBe('my_fn');
    });
});

// =============================================================================
// toOpenAIResponsesStreamChunk (lines 1683-1795)
// =============================================================================

describe('ClaudeConverter.toOpenAIResponsesStreamChunk', () => {
    test('message_start generates created/in_progress/output events', () => {
        const converter = new ClaudeConverter();
        const chunk = { type: 'message_start', message: {} };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
    });

    test('content_block_start with tool_use block adds function_call event', () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_x', name: 'fn' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(result.some(e => e.type === 'response.output_item.added')).toBe(true);
    });

    test('content_block_delta thinking_delta generates reasoning event', () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'thinking...' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(result.some(e => e.type === 'response.reasoning_summary_text.delta')).toBe(true);
    });

    test('content_block_delta input_json_delta generates tool call delta event', () => {
        const converter = new ClaudeConverter();
        const chunk = {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"k":' },
        };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(result.some(e => e.type === 'response.custom_tool_call_input.delta')).toBe(true);
    });

    test('content_block_stop adds output_item.done event', () => {
        const converter = new ClaudeConverter();
        const chunk = { type: 'content_block_stop', index: 0 };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(result.some(e => e.type === 'response.output_item.done')).toBe(true);
    });

    test('message_stop adds response completed events', () => {
        const converter = new ClaudeConverter();
        const chunk = { type: 'message_stop' };
        const result = converter.convertStreamChunk(chunk, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(result.length).toBeGreaterThan(0);
    });

    test('null chunk returns empty array', () => {
        const converter = new ClaudeConverter();
        const result = converter.convertStreamChunk(null, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'claude-3');
        expect(result).toEqual([]);
    });
});

// =============================================================================
// _shortenNameIfNeeded (lines 1807-1822)
// =============================================================================

describe('ClaudeConverter._shortenNameIfNeeded', () => {
    test('short name returned unchanged', () => {
        const converter = new ClaudeConverter();
        expect(converter._shortenNameIfNeeded('short')).toBe('short');
    });

    test('long name truncated to 64 chars', () => {
        const converter = new ClaudeConverter();
        const long = 'a'.repeat(70);
        const result = converter._shortenNameIfNeeded(long);
        expect(result.length).toBe(64);
    });

    test('mcp__ name longer than 64 chars extracts last segment', () => {
        const converter = new ClaudeConverter();
        // Need total length > 64 for the shortening to kick in
        const suffix = 'actual_tool_name'; // 16 chars
        const server = 's'.repeat(60);     // pad server so total > 64
        const name = `mcp__${server}__${suffix}`;
        const result = converter._shortenNameIfNeeded(name);
        expect(result).toBe(`mcp__${suffix}`);
    });

    test('long mcp__ name is truncated to 64', () => {
        const converter = new ClaudeConverter();
        const longSuffix = 't'.repeat(70);
        const name = `mcp__server__${longSuffix}`;
        const result = converter._shortenNameIfNeeded(name);
        expect(result.length).toBe(64);
    });
});

// =============================================================================
// _buildShortNameMap (lines 1827-1875)
// =============================================================================

describe('ClaudeConverter._buildShortNameMap', () => {
    test('short names are unchanged', () => {
        const converter = new ClaudeConverter();
        const m = converter._buildShortNameMap(['fn1', 'fn2']);
        expect(m.fn1).toBe('fn1');
        expect(m.fn2).toBe('fn2');
    });

    test('long names are shortened', () => {
        const converter = new ClaudeConverter();
        const long = 'a'.repeat(70);
        const m = converter._buildShortNameMap([long]);
        expect(m[long].length).toBe(64);
    });

    test('duplicate shortened names get unique suffixes', () => {
        const converter = new ClaudeConverter();
        // Two different long names that shorten to the same 64-char prefix
        const base = 'a'.repeat(64);
        const n1 = base + 'X';
        const n2 = base + 'Y';
        const m = converter._buildShortNameMap([n1, n2]);
        expect(m[n1]).not.toBe(m[n2]);
    });
});

// =============================================================================
// _normalizeToolParameters (lines 1880-1891)
// =============================================================================

describe('ClaudeConverter._normalizeToolParameters', () => {
    test('null returns default object schema', () => {
        const converter = new ClaudeConverter();
        const result = converter._normalizeToolParameters(null);
        expect(result.type).toBe('object');
        expect(result.properties).toEqual({});
    });

    test('non-object returns default object schema', () => {
        const converter = new ClaudeConverter();
        const result = converter._normalizeToolParameters('string');
        expect(result.type).toBe('object');
    });

    test('schema without type gets type=object added', () => {
        const converter = new ClaudeConverter();
        const result = converter._normalizeToolParameters({ properties: { x: {} } });
        expect(result.type).toBe('object');
    });

    test('schema with type=object but no properties gets properties added', () => {
        const converter = new ClaudeConverter();
        const result = converter._normalizeToolParameters({ type: 'object' });
        expect(result.properties).toEqual({});
    });

    test('schema with type=string is returned as-is (no properties added)', () => {
        const converter = new ClaudeConverter();
        const result = converter._normalizeToolParameters({ type: 'string' });
        expect(result.type).toBe('string');
        expect(result.properties).toBeUndefined();
    });
});

// =============================================================================
// toCodexRequest — system + tools (lines 1914-1984)
// =============================================================================

describe('ClaudeConverter.toCodexRequest — system and tools', () => {
    test('system as string sets instructions and developer message', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            system: 'You are a helpful assistant.',
            messages: [{ role: 'user', content: 'hi' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result.instructions).toBe('You are a helpful assistant.');
        const dev = result.input.find(i => i.role === 'developer');
        expect(dev).toBeDefined();
    });

    test('system as array joins texts and creates developer message', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            system: [
                { type: 'text', text: 'rule 1' },
                { type: 'text', text: 'rule 2' },
            ],
            messages: [{ role: 'user', content: 'hi' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result.instructions).toContain('rule 1');
        const dev = result.input.find(i => i.role === 'developer');
        expect(dev.content[0].text).toBe('rule 1');
    });

    test('system array with string parts creates developer message', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            system: ['plain string sys'],
            messages: [{ role: 'user', content: 'hi' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const dev = result.input.find(i => i.role === 'developer');
        expect(dev.content[0].text).toBe('plain string sys');
    });

    test('tools are converted to function type with normalized parameters', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [
                { name: 'search', description: 'search the web', input_schema: { type: 'object', properties: { q: {} } } },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result.tools[0].type).toBe('function');
        expect(result.tools[0].name).toBe('search');
        expect(result.tool_choice).toBe('auto');
    });

    test('web_search_20250305 tool maps to web_search type', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'web_search_20250305' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result.tools[0].type).toBe('web_search');
    });

    test('tool with long name is shortened', () => {
        const converter = new ClaudeConverter();
        const longName = 'a'.repeat(70);
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: longName, description: 'd', input_schema: null }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result.tools[0].name.length).toBeLessThanOrEqual(64);
    });

    test('tool with $schema in parameters removes it', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [
                {
                    name: 'fn',
                    description: 'd',
                    input_schema: { type: 'object', properties: {}, $schema: 'http://json-schema.org/draft-07/schema#' },
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result.tools[0].parameters.$schema).toBeUndefined();
    });
});

// =============================================================================
// toCodexRequest — message content blocks (lines 2022-2073)
// =============================================================================

describe('ClaudeConverter.toCodexRequest — message content blocks', () => {
    test('string content creates input_text message', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hello text' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const msg = result.input.find(i => i.role === 'user');
        expect(msg.content[0].type).toBe('input_text');
        expect(msg.content[0].text).toBe('hello text');
    });

    test('array content with text block creates input_text', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const msg = result.input.find(i => i.role === 'user');
        expect(msg.content[0].type).toBe('input_text');
    });

    test('assistant array content with text block creates output_text', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'response' }] }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const msg = result.input.find(i => i.role === 'assistant');
        expect(msg.content[0].type).toBe('output_text');
    });

    test('image content block with data creates input_image', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'image', source: { data: 'base64data', media_type: 'image/png' } }],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const msg = result.input.find(i => i.role === 'user');
        expect(msg.content[0].type).toBe('input_image');
    });

    test('image content block without data is skipped', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image', source: {} },
                        { type: 'text', text: 'fallback' },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const msg = result.input.find(i => i.role === 'user');
        expect(msg.content.some(c => c.type === 'input_text')).toBe(true);
    });

    test('tool_use block flushes and adds function_call', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'calling tool' },
                        { type: 'tool_use', id: 'call_1', name: 'my_fn', input: { a: 1 } },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const fnCall = result.input.find(i => i.type === 'function_call');
        expect(fnCall).toBeDefined();
        expect(fnCall.name).toBe('my_fn');
    });

    test('tool_result block flushes and adds function_call_output', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'call_1', content: 'result data' },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const out = result.input.find(i => i.type === 'function_call_output');
        expect(out).toBeDefined();
        expect(out.call_id).toBe('call_1');
        expect(out.output).toBe('result data');
    });

    test('tool_result with object content is JSON-stringified', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'call_2', content: { key: 'val' } },
                    ],
                },
            ],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        const out = result.input.find(i => i.type === 'function_call_output');
        expect(out.output).toContain('key');
    });

    test('thinking enabled sets reasoning effort', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'enabled', budget_tokens: 2048 },
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result.reasoning.effort).toBeDefined();
    });

    test('thinking disabled sets zero effort', () => {
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'disabled' },
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        expect(result.reasoning.effort).toBeDefined();
    });
});

// =============================================================================
// toCodexRequest — CODEX_INSTRUCTIONS_ENABLED env var (lines 2080-2085)
// =============================================================================

describe('ClaudeConverter.toCodexRequest — CODEX_INSTRUCTIONS_ENABLED', () => {
    test('injects instructions message when env var is true', () => {
        process.env.CODEX_INSTRUCTIONS_ENABLED = 'true';
        try {
            const converter = new ClaudeConverter();
            const req = {
                model: 'claude-3',
                messages: [{ role: 'user', content: 'hi' }],
            };
            const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
            const first = result.input[0];
            expect(first.content[0].text).toContain('EXECUTE ACCORDING TO');
        } finally {
            delete process.env.CODEX_INSTRUCTIONS_ENABLED;
        }
    });

    test('does not inject when env var is not set', () => {
        delete process.env.CODEX_INSTRUCTIONS_ENABLED;
        const converter = new ClaudeConverter();
        const req = {
            model: 'claude-3',
            messages: [{ role: 'user', content: 'hi' }],
        };
        const result = converter.convertRequest(req, MODEL_PROTOCOL_PREFIX.CODEX);
        // First input should be regular message, not instruction
        expect(result.input[0]?.content?.[0]?.text).not.toContain('EXECUTE ACCORDING TO');
    });
});
