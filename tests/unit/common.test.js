import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
    RETRYABLE_NETWORK_ERRORS,
    isRetryableNetworkError,
    getProtocolPrefix,
    MODEL_PROTOCOL_PREFIX,
    formatExpiryTime,
    formatLog,
    formatExpiryLog,
    getClientIp,
    getMD5Hash,
    extractSystemPromptFromRequestBody,
    formatToLocal,
    handleError,
} from '../../src/utils/common.js';

describe('isRetryableNetworkError', () => {
    test('returns false for null/undefined', () => {
        expect(isRetryableNetworkError(null)).toBe(false);
        expect(isRetryableNetworkError(undefined)).toBe(false);
    });

    test('matches error.code', () => {
        const err = new Error('x');
        err.code = 'ECONNRESET';
        expect(isRetryableNetworkError(err)).toBe(true);
    });

    test('matches error.message substring', () => {
        expect(isRetryableNetworkError(new Error('read ETIMEDOUT'))).toBe(true);
    });

    test('RETRYABLE_NETWORK_ERRORS is non-empty', () => {
        expect(Array.isArray(RETRYABLE_NETWORK_ERRORS)).toBe(true);
        expect(RETRYABLE_NETWORK_ERRORS.length).toBeGreaterThan(0);
    });
});

describe('getProtocolPrefix', () => {
    test('codex oauth special case', () => {
        expect(getProtocolPrefix('openai-codex-oauth')).toBe('codex');
    });

    test('cursor oauth maps to openai', () => {
        expect(getProtocolPrefix('cursor-oauth')).toBe('openai');
    });

    test('prefix before first hyphen', () => {
        expect(getProtocolPrefix('gemini-cli-oauth')).toBe('gemini');
        expect(getProtocolPrefix('openai-custom')).toBe('openai');
    });

    test('no hyphen returns original', () => {
        expect(getProtocolPrefix('auto')).toBe('auto');
    });
});

describe('formatExpiryTime', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('invalid input', () => {
        expect(formatExpiryTime(null)).toBe('No expiry date available');
        expect(formatExpiryTime('x')).toBe('No expiry date available');
    });

    test('expired', () => {
        expect(formatExpiryTime(Date.now() - 1000)).toBe('Token has expired');
    });

    test('formats remaining time with padding', () => {
        const expiry = Date.now() + (2 * 3600 + 3 * 60 + 4) * 1000;
        expect(formatExpiryTime(expiry)).toBe('02h 03m 04s');
    });
});

describe('formatLog', () => {
    test('tag and message only', () => {
        expect(formatLog('T', 'hello')).toBe('[T] hello');
    });

    test('appends object entries', () => {
        expect(formatLog('T', 'm', { a: 1, b: 2 })).toBe('[T] m | a: 1, b: 2');
    });

    test('appends primitive data', () => {
        expect(formatLog('T', 'm', 'extra')).toBe('[T] m | extra');
    });
});

describe('formatExpiryLog', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('near expiry when within window', () => {
        const near = Date.now() + 5 * 60 * 1000;
        const { isNearExpiry, message } = formatExpiryLog('Kiro', near, 10);
        expect(isNearExpiry).toBe(true);
        expect(message).toContain('[Kiro]');
        expect(message).toContain('Is near expiry: true');
    });

    test('not near expiry when beyond window', () => {
        const far = Date.now() + 60 * 60 * 1000;
        const { isNearExpiry } = formatExpiryLog('Kiro', far, 10);
        expect(isNearExpiry).toBe(false);
    });
});

describe('getClientIp', () => {
    test('uses x-forwarded-for first value', () => {
        const req = {
            headers: { 'x-forwarded-for': ' 203.0.113.1 , 10.0.0.1 ' },
            socket: { remoteAddress: '10.0.0.2' },
        };
        expect(getClientIp(req)).toBe('203.0.113.1');
    });

    test('falls back to socket and strips ipv4-mapped ipv6', () => {
        const req = {
            headers: {},
            socket: { remoteAddress: '::ffff:127.0.0.1' },
        };
        expect(getClientIp(req)).toBe('127.0.0.1');
    });

    test('unknown when no ip', () => {
        expect(getClientIp({ headers: {}, socket: {} })).toBe('unknown');
    });
});

describe('getMD5Hash', () => {
    test('stable hash for object', () => {
        expect(getMD5Hash({ a: 1 })).toBe(getMD5Hash({ a: 1 }));
        expect(getMD5Hash({ a: 1 })).not.toBe(getMD5Hash({ a: 2 }));
    });
});

describe('extractSystemPromptFromRequestBody', () => {
    test('openai: system message', () => {
        const body = {
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'hi' },
            ],
        };
        expect(extractSystemPromptFromRequestBody(body, MODEL_PROTOCOL_PREFIX.OPENAI)).toBe('sys');
    });

    test('openai: fallback to first user', () => {
        const body = {
            messages: [{ role: 'user', content: 'u1' }],
        };
        expect(extractSystemPromptFromRequestBody(body, MODEL_PROTOCOL_PREFIX.OPENAI)).toBe('u1');
    });

    test('gemini: system_instruction parts', () => {
        const body = {
            system_instruction: { parts: [{ text: 'a' }, { text: 'b' }] },
        };
        expect(extractSystemPromptFromRequestBody(body, MODEL_PROTOCOL_PREFIX.GEMINI)).toBe('a\nb');
    });

    test('claude: system string', () => {
        expect(extractSystemPromptFromRequestBody({ system: 's' }, MODEL_PROTOCOL_PREFIX.CLAUDE)).toBe('s');
    });
});

describe('formatToLocal', () => {
    test('empty input', () => {
        expect(formatToLocal(null)).toBe('--');
        expect(formatToLocal('')).toBe('--');
    });

    test('seconds timestamp scaled to ms', () => {
        const s = 1700000000;
        const out = formatToLocal(s);
        expect(out).not.toBe('--');
    });

    test('invalid date', () => {
        expect(formatToLocal('not-a-date')).toBe('--');
    });
});

describe('handleError', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('writes json payload for 401 when no custom message', () => {
        const res = {
            writableEnded: false,
            destroyed: false,
            headersSent: false,
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        const err = new Error('');
        err.statusCode = 401;
        handleError(res, err, null);
        expect(res.writeHead).toHaveBeenCalledWith(
            401,
            expect.objectContaining({ 'Content-Type': 'application/json' }),
        );
        const payload = JSON.parse(res.end.mock.calls[0][0]);
        expect(payload.error.code).toBe(401);
        expect(payload.error.message).toBeTruthy();
        expect(Array.isArray(payload.error.suggestions)).toBe(true);
    });

    test('skips write when response already ended', () => {
        const res = {
            writableEnded: true,
            destroyed: false,
            headersSent: true,
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handleError(res, Object.assign(new Error('x'), { statusCode: 500 }), null);
        expect(res.end).not.toHaveBeenCalled();
    });
});
