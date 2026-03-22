import { describe, test, expect } from '@jest/globals';
import {
    checkAndAssignOrDefault,
    safeParseJSON,
    generateId,
} from '../../../src/converters/utils.js';

describe('converter utils', () => {
    test('checkAndAssignOrDefault keeps non-zero defined values', () => {
        expect(checkAndAssignOrDefault(3, 9)).toBe(3);
        expect(checkAndAssignOrDefault('x', 'y')).toBe('x');
    });

    test('checkAndAssignOrDefault uses default for undefined or 0', () => {
        expect(checkAndAssignOrDefault(undefined, 9)).toBe(9);
        expect(checkAndAssignOrDefault(0, 9)).toBe(9);
    });

    test('safeParseJSON parses valid JSON', () => {
        expect(safeParseJSON('{"a":1}')).toEqual({ a: 1 });
    });

    test('safeParseJSON returns original string on invalid JSON', () => {
        expect(safeParseJSON('not json')).toBe('not json');
    });

    test('safeParseJSON handles empty / falsy', () => {
        expect(safeParseJSON('')).toBe('');
        expect(safeParseJSON(null)).toBe(null);
    });

    test('generateId returns string with optional prefix', () => {
        const id = generateId('p');
        expect(typeof id).toBe('string');
        expect(id.startsWith('p_')).toBe(true);
    });
});
