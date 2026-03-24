/**
 * update-api 版本比较（纯函数，可稳定单测）
 */
import { describe, test, expect } from '@jest/globals';
import { compareVersions } from '../../../src/ui-modules/update-api.js';

describe('compareVersions (update-api)', () => {
    test('strips leading v and treats equal', () => {
        expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    });

    test('v1 greater than v2', () => {
        expect(compareVersions('2.1.0', '2.0.9')).toBe(1);
    });

    test('v1 less than v2', () => {
        expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    });

    test('handles different segment lengths', () => {
        expect(compareVersions('1.0.1', '1.0')).toBe(1);
    });
});
