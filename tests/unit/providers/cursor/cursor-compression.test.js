/**
 * Tests for cursor-compression.js
 */

import { estimateMessageTokens, compressMessages, COMPRESSION_LEVEL_PARAMS } from '../../../../src/providers/cursor/cursor-compression.js';

describe('estimateMessageTokens', () => {
    test('estimates simple text messages', () => {
        const messages = [
            { role: 'user', content: 'Hello world' }, // 11 chars
        ];
        expect(estimateMessageTokens(messages)).toBe(Math.ceil(11 / 4));
    });

    test('estimates messages with tool_calls', () => {
        const messages = [
            {
                role: 'assistant',
                content: 'text',
                tool_calls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }],
            },
        ];
        const result = estimateMessageTokens(messages);
        expect(result).toBeGreaterThan(0);
    });

    test('estimates array content parts', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }] },
        ];
        expect(estimateMessageTokens(messages)).toBe(Math.ceil(11 / 4));
    });

    test('returns 0 for empty array', () => {
        expect(estimateMessageTokens([])).toBe(0);
    });
});

describe('compressMessages', () => {
    function makeMessages(count, charsPer = 1000) {
        const content = 'x'.repeat(charsPer);
        return Array.from({ length: count }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content,
        }));
    }

    test('returns original when under token threshold', () => {
        const messages = [{ role: 'user', content: 'short' }];
        const result = compressMessages(messages, { maxHistoryTokens: 120000 });
        expect(result).toBe(messages); // same reference
    });

    test('compresses when over token threshold', () => {
        // 600 messages * 5000 chars each = 3M chars = 750k tokens (well over threshold)
        // Level 2 maxChars = 2000, so 5000-char messages get truncated
        const messages = makeMessages(600, 5000);
        const result = compressMessages(messages, { maxHistoryTokens: 100000, level: 2 });
        expect(result.length).toBe(messages.length);
        // Recent 6 should be preserved
        const recentStart = messages.length - 6;
        for (let i = recentStart; i < result.length; i++) {
            expect(result[i]).toBe(messages[i]);
        }
        // Earlier messages should be truncated
        const firstCompressed = result[0];
        expect(firstCompressed.content).toContain('[...truncated...]');
    });

    test('compresses tool_calls messages to summary', () => {
        const messages = [
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: '1', type: 'function', function: { name: 'readFile', arguments: '{"path":"foo"}' } }],
            },
            { role: 'tool', content: 'x'.repeat(5000), tool_call_id: '1' },
            ...makeMessages(598, 1000),
        ];
        const result = compressMessages(messages, { maxHistoryTokens: 100000, level: 2 });
        expect(result[0].content).toContain('[Executed: readFile]');
        expect(result[0].tool_calls).toBeUndefined();
    });

    test('compresses tool result messages with head/tail', () => {
        const toolContent = 'A'.repeat(300) + 'MIDDLE'.repeat(500) + 'Z'.repeat(300);
        const messages = [
            { role: 'tool', content: toolContent, tool_call_id: '1' },
            ...makeMessages(599, 1000),
        ];
        const result = compressMessages(messages, { maxHistoryTokens: 100000, level: 2 });
        expect(result[0].content).toContain('[...');
        expect(result[0].content).toContain('chars omitted...]');
    });

    test('preserves recent messages based on level', () => {
        const messages = makeMessages(100, 5000);
        // Level 1: keepRecent = 10
        const result1 = compressMessages(messages, { maxHistoryTokens: 1, level: 1 });
        const recentStart1 = messages.length - 10;
        for (let i = recentStart1; i < result1.length; i++) {
            expect(result1[i]).toBe(messages[i]);
        }
        // Level 3: keepRecent = 4
        const result3 = compressMessages(messages, { maxHistoryTokens: 1, level: 3 });
        const recentStart3 = messages.length - 4;
        for (let i = recentStart3; i < result3.length; i++) {
            expect(result3[i]).toBe(messages[i]);
        }
    });

    test('allows keepRecent override', () => {
        const messages = makeMessages(50, 5000);
        const result = compressMessages(messages, { maxHistoryTokens: 1, level: 2, keepRecent: 2 });
        // Last 2 should be uncompressed
        expect(result[result.length - 1]).toBe(messages[messages.length - 1]);
        expect(result[result.length - 2]).toBe(messages[messages.length - 2]);
        // Earlier ones should be compressed
        expect(result[0].content).toContain('[...truncated...]');
    });
});

describe('COMPRESSION_LEVEL_PARAMS', () => {
    test('has all three levels', () => {
        expect(COMPRESSION_LEVEL_PARAMS).toHaveProperty('1');
        expect(COMPRESSION_LEVEL_PARAMS).toHaveProperty('2');
        expect(COMPRESSION_LEVEL_PARAMS).toHaveProperty('3');
    });

    test('level 1 has largest limits', () => {
        expect(COMPRESSION_LEVEL_PARAMS[1].maxChars).toBeGreaterThan(COMPRESSION_LEVEL_PARAMS[2].maxChars);
        expect(COMPRESSION_LEVEL_PARAMS[2].maxChars).toBeGreaterThan(COMPRESSION_LEVEL_PARAMS[3].maxChars);
    });
});
