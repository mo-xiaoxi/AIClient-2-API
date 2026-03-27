/**
 * Tests for cursor-tool-fixer.js
 *
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let replaceSmartQuotes;
let repairExactMatchToolArguments;
let fixToolCallArguments;
let mockExistsSync;
let mockReadFileSync;

beforeAll(async () => {
    mockExistsSync = jest.fn();
    mockReadFileSync = jest.fn();

    await jest.unstable_mockModule('node:fs', () => ({
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
    }));

    const mod = await import('../../../../src/providers/cursor/cursor-tool-fixer.js');
    replaceSmartQuotes = mod.replaceSmartQuotes;
    repairExactMatchToolArguments = mod.repairExactMatchToolArguments;
    fixToolCallArguments = mod.fixToolCallArguments;
});

describe('replaceSmartQuotes', () => {
    test('replaces left/right double quotes', () => {
        expect(replaceSmartQuotes('\u201cHello\u201d')).toBe('"Hello"');
    });

    test('replaces left/right single quotes', () => {
        expect(replaceSmartQuotes('\u2018it\u2019s')).toBe("'it's");
    });

    test('replaces guillemets', () => {
        expect(replaceSmartQuotes('\u00abtest\u00bb')).toBe('"test"');
    });

    test('leaves ASCII quotes untouched', () => {
        expect(replaceSmartQuotes('"hello" \'world\'')).toBe('"hello" \'world\'');
    });

    test('handles null/empty', () => {
        expect(replaceSmartQuotes('')).toBe('');
        expect(replaceSmartQuotes(null)).toBeNull();
    });
});

describe('repairExactMatchToolArguments', () => {
    beforeEach(() => {
        mockExistsSync.mockReset();
        mockReadFileSync.mockReset();
    });

    test('skips non-str_replace tools', () => {
        const args = { old_string: 'foo', path: '/test' };
        const result = repairExactMatchToolArguments('readFile', args);
        expect(result).toBe(args); // unchanged
    });

    test('skips when old_string already matches', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('exact content here');
        const args = { old_string: 'exact content', path: '/test.js' };
        repairExactMatchToolArguments('str_replace', args);
        expect(args.old_string).toBe('exact content');
    });

    test('repairs with fuzzy match when unique', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('const x = "hello";\nconst y = "world";');
        const args = {
            old_string: 'const x = \u201chello\u201d;', // smart quotes
            new_string: '\u201cnew value\u201d',
            path: '/test.js',
        };
        repairExactMatchToolArguments('str_replace', args);
        expect(args.old_string).toBe('const x = "hello";');
        // new_string should also have smart quotes fixed
        expect(args.new_string).toBe('"new value"');
    });

    test('does not repair when multiple matches', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('"hello"\n"hello"');
        const args = { old_string: '\u201chello\u201d', path: '/test.js' };
        repairExactMatchToolArguments('str_replace', args);
        // Should remain unchanged (best-effort)
        expect(args.old_string).toBe('\u201chello\u201d');
    });

    test('does not repair when no matches', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('totally different content');
        const args = { old_string: '\u201cmissing\u201d', path: '/test.js' };
        repairExactMatchToolArguments('str_replace', args);
        expect(args.old_string).toBe('\u201cmissing\u201d');
    });

    test('handles file not found gracefully', () => {
        mockExistsSync.mockReturnValue(false);
        const args = { old_string: 'foo', path: '/nonexistent.js' };
        const result = repairExactMatchToolArguments('str_replace', args);
        expect(result).toBe(args);
    });

    test('handles file read error gracefully', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockImplementation(() => { throw new Error('EACCES'); });
        const args = { old_string: 'foo', path: '/test.js' };
        expect(() => repairExactMatchToolArguments('str_replace', args)).not.toThrow();
    });

    test('works with search_replace tool name', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('const x = "test";');
        const args = { old_string: 'const x = \u201ctest\u201d;', path: '/test.js' };
        repairExactMatchToolArguments('search_replace', args);
        expect(args.old_string).toBe('const x = "test";');
    });
});

describe('fixToolCallArguments', () => {
    beforeEach(() => {
        mockExistsSync.mockReset();
        mockReadFileSync.mockReset();
        mockExistsSync.mockReturnValue(false);
    });

    test('replaces smart quotes in all string values', () => {
        const args = { key: '\u201cvalue\u201d', num: 42 };
        const result = fixToolCallArguments('anyTool', args);
        expect(result.key).toBe('"value"');
        expect(result.num).toBe(42);
    });

    test('handles null args', () => {
        expect(fixToolCallArguments('test', null)).toBeNull();
    });

    test('handles non-object args', () => {
        expect(fixToolCallArguments('test', 'string')).toBe('string');
    });
});
