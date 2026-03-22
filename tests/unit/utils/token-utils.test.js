import { describe, test, expect } from '@jest/globals';
import {
    getContentText,
    processContent,
    countTextTokens,
    estimateInputTokens,
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
});
