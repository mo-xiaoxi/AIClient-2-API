import { describe, test, expect } from '@jest/globals';
import {
    getContentText,
    processContent,
    countTextTokens,
    estimateInputTokens,
    countTokensAnthropic,
} from '../../../src/utils/token-utils.js';

describe('token-utils', () => {
    test('getContentText from string content', () => {
        expect(getContentText({ content: 'abc' })).toBe('abc');
    });

    test('getContentText from parts array', () => {
        expect(
            getContentText({
                content: [
                    { type: 'text', text: 'a' },
                    { type: 'text', text: 'b' },
                ],
            })
        ).toBe('ab');
    });

    test('processContent handles tool_result nesting', () => {
        expect(
            processContent([
                { type: 'tool_result', content: [{ type: 'text', text: 'inner' }] },
            ])
        ).toBe('inner');
    });

    test('countTextTokens non-empty', () => {
        expect(countTextTokens('hello')).toBeGreaterThan(0);
    });

    test('estimateInputTokens aggregates messages', () => {
        const n = estimateInputTokens({
            messages: [
                { role: 'user', content: 'hello world' },
                { role: 'assistant', content: 'reply' },
            ],
        });
        expect(n).toBeGreaterThan(0);
    });

    test('getContentText handles top-level array message', () => {
        expect(
            getContentText([
                { type: 'text', text: 'a' },
                { type: 'text', text: 'b' },
            ]),
        ).toBe('ab');
    });

    test('processContent thinking and tool_use branches', () => {
        expect(
            processContent([
                { type: 'thinking', thinking: 't' },
                { type: 'tool_use', input: { x: 1 } },
            ]),
        ).toContain('t');
        expect(processContent([{ type: 'tool_use', input: { x: 1 } }])).toContain('x');
    });

    test('estimateInputTokens includes thinking enabled budget', () => {
        const n = estimateInputTokens({
            thinking: { type: 'enabled', budget_tokens: 2048 },
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(n).toBeGreaterThan(20);
    });

    test('estimateInputTokens adaptive thinking effort', () => {
        const n = estimateInputTokens({
            thinking: { type: 'adaptive', effort: 'low' },
            messages: [],
        });
        expect(n).toBeGreaterThan(0);
    });

    test('countTokensAnthropic adds image block cost', () => {
        const { input_tokens } = countTokensAnthropic({
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'image', source: {} }],
                },
            ],
        });
        expect(input_tokens).toBeGreaterThanOrEqual(1600);
    });

    test('countTokensAnthropic system string', () => {
        const { input_tokens } = countTokensAnthropic({
            system: 'You are helpful',
            messages: [{ role: 'user', content: 'q' }],
        });
        expect(input_tokens).toBeGreaterThan(0);
    });

    // --- getContentText edge cases ---

    test('getContentText returns empty string for null input', () => {
        expect(getContentText(null)).toBe('');
    });

    test('getContentText returns empty string for undefined input', () => {
        expect(getContentText(undefined)).toBe('');
    });

    test('getContentText array: part with text but no type', () => {
        expect(getContentText([{ text: 'hello' }])).toBe('hello');
    });

    test('getContentText array: part with no text returns empty string', () => {
        expect(getContentText([{}])).toBe('');
    });

    test('getContentText message.content array: part with text but no type', () => {
        expect(getContentText({ content: [{ text: 'bar' }] })).toBe('bar');
    });

    test('getContentText message.content array: part with no text', () => {
        expect(getContentText({ content: [{}] })).toBe('');
    });

    test('getContentText falls back to String(message) for non-string non-array content', () => {
        const result = getContentText({ content: 42 });
        expect(result).toBe('42');
    });

    // --- processContent edge cases ---

    test('processContent: part with text but unknown type', () => {
        expect(processContent([{ type: 'unknown', text: 'raw' }])).toBe('raw');
    });

    test('processContent: part object with no text returns empty string', () => {
        expect(processContent([{}])).toBe('');
    });

    test('processContent: thinking part with no .thinking falls back to .text', () => {
        expect(processContent([{ type: 'thinking', text: 'text-fallback' }])).toBe('text-fallback');
    });

    test('processContent: non-array object delegates to getContentText', () => {
        const result = processContent({ content: 'hello from obj' });
        expect(result).toBe('hello from obj');
    });

    // --- estimateInputTokens edge cases ---

    test('estimateInputTokens includes system prompt text', () => {
        const n = estimateInputTokens({
            system: 'You are a helpful assistant.',
            messages: [],
        });
        expect(n).toBeGreaterThan(0);
    });

    test('estimateInputTokens uses default budget when budget_tokens is invalid', () => {
        const n = estimateInputTokens({
            thinking: { type: 'enabled', budget_tokens: -999 },
            messages: [],
        });
        expect(n).toBeGreaterThan(0);
    });

    test('estimateInputTokens includes tools tokens', () => {
        const n = estimateInputTokens({
            messages: [],
            tools: [{ name: 'get_weather', description: 'Returns weather for a given location', input_schema: {} }],
        });
        expect(n).toBeGreaterThan(0);
    });

    // --- countTokensAnthropic edge cases ---

    test('countTokensAnthropic counts document block with base64 source', () => {
        const { input_tokens } = countTokensAnthropic({
            messages: [{
                role: 'user',
                content: [{
                    type: 'document',
                    source: { data: 'aGVsbG8gd29ybGQ=' }, // base64 "hello world"
                }],
            }],
        });
        expect(input_tokens).toBeGreaterThan(0);
    });

    test('countTokensAnthropic counts text block in content array', () => {
        const { input_tokens } = countTokensAnthropic({
            messages: [{
                role: 'user',
                content: [{ type: 'text', text: 'hello from block' }],
            }],
        });
        expect(input_tokens).toBeGreaterThan(0);
    });
});
