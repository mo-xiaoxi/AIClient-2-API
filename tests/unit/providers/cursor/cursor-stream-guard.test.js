/**
 * Tests for cursor-stream-guard.js — createStreamGuard
 */

import { createStreamGuard } from '../../../../src/providers/cursor/cursor-stream-guard.js';

describe('createStreamGuard', () => {
    describe('warmup phase', () => {
        test('buffers text until warmup threshold', () => {
            const guard = createStreamGuard({ warmupChars: 20, guardChars: 10 });
            // Push short text — should stay buffered
            const result = guard.push('Hello');
            expect(result).toBe('');
            expect(guard.hasUnlocked()).toBe(false);
        });

        test('unlocks after reaching warmup chars', () => {
            const guard = createStreamGuard({ warmupChars: 10, guardChars: 5 });
            const result = guard.push('Hello World! This is enough text.');
            expect(guard.hasUnlocked()).toBe(true);
            // Should emit text minus guardChars (5)
            expect(result.length).toBeGreaterThan(0);
        });

        test('unlocks early on sentence boundary', () => {
            const guard = createStreamGuard({ warmupChars: 100, guardChars: 5 });
            // Contains period — should unlock even before warmupChars
            const result = guard.push('Hello. More text here now.');
            expect(guard.hasUnlocked()).toBe(true);
        });

        test('stays locked if isBlockedPrefix returns true', () => {
            const guard = createStreamGuard({
                warmupChars: 5,
                guardChars: 0,
                isBlockedPrefix: (text) => text.startsWith('ERROR'),
            });
            const result = guard.push('ERROR: something went wrong');
            expect(result).toBe('');
            expect(guard.hasUnlocked()).toBe(false);
        });
    });

    describe('guard buffering', () => {
        test('retains tail guardChars unreleased', () => {
            const guard = createStreamGuard({ warmupChars: 0, guardChars: 10 });
            // Push enough to unlock immediately (warmup=0 still needs non-empty trim)
            const result = guard.push('A sentence. And more text follows here.');
            // Should have withheld last 10 chars
            const fullText = 'A sentence. And more text follows here.';
            expect(result.length).toBe(fullText.length - 10);
        });

        test('accumulates guard across multiple pushes', () => {
            const guard = createStreamGuard({ warmupChars: 0, guardChars: 10 });
            guard.push('Hello. ');
            const r2 = guard.push('World! More text.');
            // Total text = "Hello. World! More text." (24 chars)
            // Guard keeps last 10, so emits up to char 14
            expect(guard.hasUnlocked()).toBe(true);
        });
    });

    describe('finish', () => {
        test('releases all remaining buffered text', () => {
            const guard = createStreamGuard({ warmupChars: 10, guardChars: 10 });
            guard.push('Hello World! Some extra text here.');
            const remaining = guard.finish();
            expect(remaining.length).toBeGreaterThan(0);
        });

        test('returns empty string on empty input', () => {
            const guard = createStreamGuard();
            expect(guard.finish()).toBe('');
        });

        test('all text is eventually emitted', () => {
            const guard = createStreamGuard({ warmupChars: 5, guardChars: 10 });
            const fullText = 'Hello. This is a test of the stream guard system.';
            let emitted = '';
            emitted += guard.push(fullText);
            emitted += guard.finish();
            expect(emitted).toBe(fullText);
        });
    });

    describe('defaults', () => {
        test('uses default warmupChars=96 and guardChars=256', () => {
            const guard = createStreamGuard();
            // Push short text — should buffer
            expect(guard.push('Hi')).toBe('');
            expect(guard.hasUnlocked()).toBe(false);
        });
    });

    describe('HTML content validity', () => {
        test('stays locked for pure HTML token content below guardChars', () => {
            const guard = createStreamGuard({ warmupChars: 5, guardChars: 500 });
            // Pure HTML tokens — low valid ratio
            const result = guard.push('<br><br><br><br>');
            expect(result).toBe('');
            expect(guard.hasUnlocked()).toBe(false);
        });
    });
});
