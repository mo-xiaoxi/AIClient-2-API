/**
 * cursor-stream-guard.js
 *
 * Stream guard for incremental text release.
 * Provides warmup buffering (delay initial output to detect rejection prefixes)
 * and guard buffering (keep tail unreleased for cross-chunk processing).
 *
 * Ported from cursor2api streaming-text.ts createIncrementalTextStreamer.
 */

const DEFAULT_WARMUP_CHARS = 96;
const DEFAULT_GUARD_CHARS = 256;
const STREAM_START_BOUNDARY_RE = /[\n。！？.!?]/;
const HTML_TOKEN_STRIP_RE = /(<\/?[a-z][a-z0-9]*\s*\/?>|&[a-z]+;)/gi;
const HTML_VALID_RATIO_MIN = 0.2;

/**
 * Create a stream guard for incremental text release.
 *
 * @param {object} [options]
 * @param {number} [options.warmupChars=96] - Chars to buffer before unlocking
 * @param {number} [options.guardChars=256] - Tail chars to keep unreleased
 * @param {(text: string) => boolean} [options.isBlockedPrefix] - Returns true if text looks like a blocked prefix
 * @returns {{ push(chunk: string): string, finish(): string, hasUnlocked(): boolean }}
 */
export function createStreamGuard(options = {}) {
    const warmupChars = options.warmupChars ?? DEFAULT_WARMUP_CHARS;
    const guardChars = options.guardChars ?? DEFAULT_GUARD_CHARS;
    const isBlockedPrefix = options.isBlockedPrefix ?? (() => false);

    let rawText = '';
    let sentLength = 0;
    let unlocked = false;

    function tryUnlock() {
        if (unlocked) return true;

        const preview = rawText;
        if (!preview.trim()) return false;

        const hasBoundary = STREAM_START_BOUNDARY_RE.test(preview);
        const enoughChars = preview.length >= warmupChars;
        if (!hasBoundary && !enoughChars) return false;

        if (isBlockedPrefix(preview.trim())) return false;

        // HTML content validity check: prevent pure HTML token sequences from unlocking
        if (preview.length < guardChars) {
            const noSpace = preview.replace(/\s/g, '');
            const stripped = noSpace.replace(HTML_TOKEN_STRIP_RE, '');
            const ratio = noSpace.length === 0 ? 0 : stripped.length / noSpace.length;
            if (ratio < HTML_VALID_RATIO_MIN) return false;
        }

        unlocked = true;
        return true;
    }

    return {
        /**
         * Push a new chunk. Returns the text that can be immediately sent.
         * @param {string} chunk
         * @returns {string}
         */
        push(chunk) {
            if (!chunk) return '';
            rawText += chunk;
            if (!tryUnlock()) return '';

            const safeLength = Math.max(0, rawText.length - guardChars);
            if (safeLength <= sentLength) return '';

            const delta = rawText.slice(sentLength, safeLength);
            sentLength = safeLength;
            return delta;
        },

        /**
         * Flush all remaining buffered text. Call when stream ends.
         * @returns {string}
         */
        finish() {
            if (!unlocked) return ''; // Respect blocked state — don't leak blocked content
            if (!rawText) return '';
            if (rawText.length <= sentLength) return '';
            const delta = rawText.slice(sentLength);
            sentLength = rawText.length;
            return delta;
        },

        /**
         * Whether the warmup phase has completed.
         * @returns {boolean}
         */
        hasUnlocked() {
            return unlocked;
        },
    };
}
