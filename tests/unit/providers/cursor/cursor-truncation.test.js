/**
 * Unit tests for cursor-truncation.js
 *
 * Tests: isTruncated, deduplicateContinuation, closeUnclosedThinking,
 *        buildContinuationPrompt
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

let isTruncated;
let deduplicateContinuation;
let closeUnclosedThinking;
let buildContinuationPrompt;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    const mod = await import('../../../../src/providers/cursor/cursor-truncation.js');
    isTruncated = mod.isTruncated;
    deduplicateContinuation = mod.deduplicateContinuation;
    closeUnclosedThinking = mod.closeUnclosedThinking;
    buildContinuationPrompt = mod.buildContinuationPrompt;
});

// ============================================================================
// isTruncated
// ============================================================================

describe('isTruncated', () => {
    test('returns false for empty text', () => {
        expect(isTruncated('')).toBe(false);
        expect(isTruncated('   ')).toBe(false);
        expect(isTruncated(null)).toBe(false);
        expect(isTruncated(undefined)).toBe(false);
    });

    test('returns false for a normal complete sentence', () => {
        expect(isTruncated('Hello, this is a complete response.')).toBe(false);
    });

    test('returns true when code block is unclosed (odd number of ``` fences)', () => {
        const text = 'Here is some code:\n```javascript\nconst x = 1;\n';
        expect(isTruncated(text)).toBe(true);
    });

    test('returns false when code block is properly closed', () => {
        const text = 'Here is some code:\n```javascript\nconst x = 1;\n```\n\nDone.';
        expect(isTruncated(text)).toBe(false);
    });

    test('returns false when two code blocks are both closed', () => {
        const text = '```js\nfoo();\n```\n\nAnd also:\n```py\nbar()\n```';
        expect(isTruncated(text)).toBe(false);
    });

    test('returns true when JSON action block is unclosed (hasTools=true)', () => {
        const text = 'Calling tool:\n```json action\n{"name":"edit_file"}\n';
        expect(isTruncated(text, true)).toBe(true);
    });

    test('returns false when JSON action block is closed (hasTools=true)', () => {
        const text = 'Calling tool:\n```json action\n{"name":"edit_file"}\n```\n';
        expect(isTruncated(text, true)).toBe(false);
    });

    test('returns true when XML tags are unclosed (more opens than closes by >1)', () => {
        // 2 opens, 0 closes -> openTags(2) > closeTags(0) + 1 -> true
        const text = '<result>\n<item>\nsome data';
        expect(isTruncated(text)).toBe(true);
    });

    test('returns false when XML tags are balanced', () => {
        const text = '<result>\nsome data\n</result>';
        expect(isTruncated(text)).toBe(false);
    });

    test('returns false when one open tag with no close (openTags=1, closeTags=0, 1 > 0+1 is false)', () => {
        // openTags(1) > closeTags(0)+1 => 1 > 1 => false
        const text = '<result>\nsome data';
        expect(isTruncated(text)).toBe(false);
    });

    test('returns true when text ends with comma', () => {
        expect(isTruncated('Here are items: a, b,')).toBe(true);
    });

    test('returns true when text ends with semicolon', () => {
        expect(isTruncated('function foo() { return 1;')).toBe(true);
    });

    test('returns true when text ends with colon', () => {
        expect(isTruncated('The following items:')).toBe(true);
    });

    test('returns true when text ends with open bracket', () => {
        expect(isTruncated('const arr = [')).toBe(true);
    });

    test('returns true when text ends with open brace', () => {
        expect(isTruncated('const obj = {')).toBe(true);
    });

    test('returns true when text ends with open paren', () => {
        expect(isTruncated('foo(')).toBe(true);
    });

    test('returns true for long response ending with newline (JSON mid-string truncation)', () => {
        // > 2000 chars, ends with \n, not a closing ```
        const longText = 'a'.repeat(2001) + '\n';
        expect(isTruncated(longText)).toBe(true);
    });

    test('returns false for long response ending with closing code fence', () => {
        // Two fences (even) = closed block; ends with ``` so heuristic 5 excludes it
        const longText = '```js\n' + 'a'.repeat(2001) + '\n```';
        expect(isTruncated(longText)).toBe(false);
    });

    test('returns false for short response ending with newline', () => {
        expect(isTruncated('short response\n')).toBe(false);
    });
});

// ============================================================================
// deduplicateContinuation
// ============================================================================

describe('deduplicateContinuation', () => {
    test('returns continuation as-is when there is no overlap', () => {
        const existing = 'Hello world';
        const continuation = ' and more content here.';
        const result = deduplicateContinuation(existing, continuation);
        expect(result).toBe(' and more content here.');
    });

    test('removes character-level overlap correctly', () => {
        const existing = 'Hello, this is the end of';
        const continuation = ' the end of the sentence.';
        const result = deduplicateContinuation(existing, continuation);
        // " the end of" is an overlap, so continuation should start after that
        expect(result).toContain('the sentence.');
        expect(result).not.toContain('Hello');
    });

    test('handles exact character overlap at boundary', () => {
        const existing = 'The quick brown fox';
        const continuation = 'fox jumps over the lazy dog';
        const result = deduplicateContinuation(existing, continuation);
        expect(result).toBe(' jumps over the lazy dog');
    });

    test('handles line-level deduplication as fallback', () => {
        const existing = 'Line one\nLine two\nLine three';
        const continuation = 'Line three\nLine four\nLine five';
        const result = deduplicateContinuation(existing, continuation);
        // After removing "Line three" overlap, remaining is "\nLine four\nLine five"
        expect(result).toContain('Line four');
        expect(result).toContain('Line five');
        expect(result).not.toContain('Line one');
    });

    test('returns empty string when continuation is completely overlapping', () => {
        const existing = 'The complete sentence here.';
        const continuation = 'complete sentence here.';
        const result = deduplicateContinuation(existing, continuation);
        // The overlap removes "complete sentence here.", leaving ""
        expect(result).toBe('');
    });

    test('handles empty existing text', () => {
        const result = deduplicateContinuation('', 'new content');
        expect(result).toBe('new content');
    });

    test('handles empty continuation', () => {
        const result = deduplicateContinuation('existing text', '');
        expect(result).toBe('');
    });

    test('handles both empty', () => {
        const result = deduplicateContinuation('', '');
        expect(result).toBe('');
    });
});

// ============================================================================
// closeUnclosedThinking
// ============================================================================

describe('closeUnclosedThinking', () => {
    test('adds closing tag when thinking is unclosed', () => {
        const text = '<think>some reasoning here';
        const result = closeUnclosedThinking(text);
        expect(result).toBe('<think>some reasoning here</think>');
    });

    test('does not modify text when thinking is already closed', () => {
        const text = '<think>reasoning</think> and the answer is 42.';
        const result = closeUnclosedThinking(text);
        expect(result).toBe(text);
    });

    test('does not modify text with no thinking tag', () => {
        const text = 'Just a normal response without thinking.';
        const result = closeUnclosedThinking(text);
        expect(result).toBe(text);
    });

    test('handles multiple think tags - only adds one close if last is unclosed', () => {
        // Two opens, two closes - balanced
        const text = '<think>first</think><think>second</think>answer';
        const result = closeUnclosedThinking(text);
        expect(result).toBe(text);
    });

    test('handles empty text', () => {
        expect(closeUnclosedThinking('')).toBe('');
        expect(closeUnclosedThinking(null)).toBe('');
        expect(closeUnclosedThinking(undefined)).toBe('');
    });
});

// ============================================================================
// buildContinuationPrompt
// ============================================================================

describe('buildContinuationPrompt', () => {
    test('generates prompt containing the instruction to continue', () => {
        const text = 'Some previous response text.';
        const prompt = buildContinuationPrompt(text);
        expect(prompt).toContain('Continue EXACTLY from where you stopped');
        expect(prompt).toContain('DO NOT repeat any content');
        expect(prompt).toContain('DO NOT restart the response');
    });

    test('includes the last 300 chars of text as anchor', () => {
        const shortText = 'Short text ending here...';
        const prompt = buildContinuationPrompt(shortText);
        expect(prompt).toContain('Short text ending here...');
    });

    test('uses only last 300 chars as anchor for long text', () => {
        const longText = 'A'.repeat(400) + 'ANCHOR_CONTENT_HERE';
        const prompt = buildContinuationPrompt(longText);
        // Should contain anchor
        expect(prompt).toContain('ANCHOR_CONTENT_HERE');
        // Should NOT contain the full 400 A's (only 300 chars from end)
        expect(prompt).not.toContain('A'.repeat(400));
    });

    test('prompt contains a code fence block with the anchor', () => {
        const text = 'Some text here.';
        const prompt = buildContinuationPrompt(text);
        expect(prompt).toContain('```');
    });

    test('mentions previous response was cut off', () => {
        const prompt = buildContinuationPrompt('text');
        expect(prompt).toContain('cut off');
    });
});
