import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
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
    getRequestBody,
    isAuthorized,
    handleUnifiedResponse,
    logConversation,
} from '../../../src/utils/common.js';
import logger from '../../../src/utils/logger.js';

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

function makeMockReqForBody(bodyStr, { emitError } = {}) {
    const listeners = {};
    return {
        on(event, cb) {
            listeners[event] = cb;
            return this;
        },
        _flush() {
            if (emitError) {
                listeners.error?.(emitError);
                return;
            }
            if (bodyStr) listeners.data?.(Buffer.from(bodyStr));
            listeners.end?.();
        },
    };
}

describe('getRequestBody', () => {
    test('parses JSON object', async () => {
        const req = makeMockReqForBody('{"a":1}');
        const p = getRequestBody(req);
        process.nextTick(() => req._flush());
        await expect(p).resolves.toEqual({ a: 1 });
    });

    test('empty body resolves to {}', async () => {
        const req = makeMockReqForBody('');
        const p = getRequestBody(req);
        process.nextTick(() => req._flush());
        await expect(p).resolves.toEqual({});
    });

    test('invalid JSON rejects', async () => {
        const req = makeMockReqForBody('{');
        const p = getRequestBody(req);
        process.nextTick(() => req._flush());
        await expect(p).rejects.toThrow(/Invalid JSON/);
    });

    test('req error event rejects', async () => {
        const req = makeMockReqForBody('', { emitError: new Error('net') });
        const p = getRequestBody(req);
        process.nextTick(() => req._flush());
        await expect(p).rejects.toThrow('net');
    });
});

describe('isAuthorized', () => {
    const key = 'secret-key';

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('Bearer token matches', () => {
        const req = { headers: { authorization: `Bearer ${key}` } };
        expect(isAuthorized(req, new URL('http://localhost/v1'), key)).toBe(true);
    });

    test('query key matches', () => {
        const req = { headers: {} };
        expect(isAuthorized(req, new URL(`http://localhost/x?key=${key}`), key)).toBe(true);
    });

    test('x-goog-api-key matches', () => {
        const req = { headers: { 'x-goog-api-key': key } };
        expect(isAuthorized(req, new URL('http://localhost/'), key)).toBe(true);
    });

    test('x-api-key matches', () => {
        const req = { headers: { 'x-api-key': key } };
        expect(isAuthorized(req, new URL('http://localhost/'), key)).toBe(true);
    });

    test('wrong key returns false', () => {
        jest.spyOn(logger, 'info').mockImplementation(() => {});
        const req = { headers: { authorization: 'Bearer wrong' } };
        expect(isAuthorized(req, new URL('http://localhost/'), key)).toBe(false);
    });
});

describe('handleUnifiedResponse', () => {
    test('non-stream writes JSON and ends', async () => {
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        await handleUnifiedResponse(res, '{"ok":true}', false);
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(res.end).toHaveBeenCalledWith('{"ok":true}');
    });

    test('stream sets SSE headers and does not end in handler', async () => {
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        await handleUnifiedResponse(res, null, true);
        expect(res.writeHead).toHaveBeenCalledWith(
            200,
            expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
        );
        expect(res.end).not.toHaveBeenCalled();
    });
});

describe('logConversation', () => {
    beforeEach(() => {
        jest.spyOn(logger, 'info').mockImplementation(() => {});
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        logger.info.mockClear();
        logger.error.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('none mode does nothing', async () => {
        await logConversation('in', 'x', 'none', '/tmp/a.log');
        expect(logger.info).not.toHaveBeenCalled();
    });

    test('empty content returns', async () => {
        await logConversation('in', '', 'console', null);
        expect(logger.info).not.toHaveBeenCalled();
    });

    test('console mode logs via logger', async () => {
        await logConversation('in', 'hello', 'console', null);
        expect(logger.info).toHaveBeenCalled();
    });

    test('file mode appends', async () => {
        jest.spyOn(fs, 'appendFile').mockResolvedValue(undefined);
        await logConversation('in', 'line', 'file', '/tmp/test-conv.log');
        expect(fs.appendFile).toHaveBeenCalledWith('/tmp/test-conv.log', expect.stringContaining('line'));
    });

    test('file mode logs error on failure', async () => {
        jest.spyOn(fs, 'appendFile').mockRejectedValue(new Error('disk full'));
        await logConversation('in', 'line', 'file', '/tmp/x');
        expect(logger.error).toHaveBeenCalled();
    });
});

describe('extractSystemPromptFromRequestBody (extra branches)', () => {
    test('gemini: fallback to first user content in contents', () => {
        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: 'from-user' }],
                },
            ],
        };
        expect(extractSystemPromptFromRequestBody(body, MODEL_PROTOCOL_PREFIX.GEMINI)).toBe('from-user');
    });

    test('claude: system as object becomes JSON string', () => {
        expect(
            extractSystemPromptFromRequestBody({ system: { foo: 1 } }, MODEL_PROTOCOL_PREFIX.CLAUDE),
        ).toBe('{"foo":1}');
    });

    test('claude: user message with array content blocks', () => {
        const body = {
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'text', text: 'block' }],
                },
            ],
        };
        expect(extractSystemPromptFromRequestBody(body, MODEL_PROTOCOL_PREFIX.CLAUDE)).toBe('block');
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

    test('403 includes permission suggestions for gemini provider', () => {
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        const res = {
            writableEnded: false,
            destroyed: false,
            headersSent: false,
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handleError(res, Object.assign(new Error('forbidden'), { statusCode: 403 }), 'gemini-cli-oauth');
        const payload = JSON.parse(res.end.mock.calls[0][0]);
        expect(payload.error.code).toBe(403);
        expect(payload.error.suggestions.some((s) => /Google Cloud|Gemini/i.test(s))).toBe(true);
    });

    test('429 rate limit message', () => {
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        const res = {
            writableEnded: false,
            destroyed: false,
            headersSent: false,
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handleError(res, Object.assign(new Error(''), { statusCode: 429 }), 'openai-custom');
        const payload = JSON.parse(res.end.mock.calls[0][0]);
        expect(payload.error.code).toBe(429);
        expect(payload.error.message).toContain('Too many requests');
    });

    test('404 client error uses default message with status code', () => {
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        const res = {
            writableEnded: false,
            destroyed: false,
            headersSent: false,
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handleError(res, Object.assign(new Error('Not found'), { statusCode: 404 }), null);
        const payload = JSON.parse(res.end.mock.calls[0][0]);
        expect(payload.error.code).toBe(404);
    });

    test('501 server error uses default message with status code', () => {
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        const res = {
            writableEnded: false,
            destroyed: false,
            headersSent: false,
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handleError(res, Object.assign(new Error('Not implemented'), { statusCode: 501 }), null);
        const payload = JSON.parse(res.end.mock.calls[0][0]);
        expect(payload.error.code).toBe(501);
    });

    test('handles res.end throwing silently', () => {
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        const res = {
            writableEnded: false,
            destroyed: false,
            headersSent: false,
            writeHead: jest.fn(),
            end: jest.fn().mockImplementation(() => { throw new Error('stream closed'); }),
        };
        expect(() => handleError(res, Object.assign(new Error('err'), { statusCode: 500 }), null)).not.toThrow();
    });

    test('403 with claude provider includes claude-specific suggestions', () => {
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        const res = {
            writableEnded: false,
            destroyed: false,
            headersSent: false,
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handleError(res, Object.assign(new Error('Forbidden'), { statusCode: 403 }), 'claude-custom');
        const payload = JSON.parse(res.end.mock.calls[0][0]);
        expect(payload.error.code).toBe(403);
        // Claude provider should have Anthropic-specific suggestions
        expect(Array.isArray(payload.error.suggestions)).toBe(true);
    });
});

describe('extractSystemPromptFromRequestBody — branch coverage', () => {
    test('CLAUDE with string user message fallback', () => {
        const result = extractSystemPromptFromRequestBody({
            messages: [{ role: 'user', content: 'user question' }],
        }, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result).toBe('user question');
    });

    test('CLAUDE with array user message fallback', () => {
        const result = extractSystemPromptFromRequestBody({
            messages: [{ role: 'user', content: [{ text: 'hello' }, { text: ' world' }] }],
        }, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result).toContain('hello');
    });

    test('CLAUDE with system object', () => {
        const result = extractSystemPromptFromRequestBody({
            system: { prompt: 'You are helpful' },
        }, MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(result).toContain('prompt');
    });

    test('unknown provider returns empty string and logs warn', () => {
        jest.spyOn(logger, 'warn').mockImplementation(() => {});
        const result = extractSystemPromptFromRequestBody({}, 'unknown-provider');
        expect(result).toBe('');
        jest.restoreAllMocks();
    });
});
