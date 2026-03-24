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
});
