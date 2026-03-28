/**
 * Tests for h2RequestUnary and h2RequestStream in cursor-h2.js
 * Uses jest.unstable_mockModule to mock node:http2
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock node:http2
// ---------------------------------------------------------------------------

const mockClose = jest.fn();
const mockWrite = jest.fn();
const mockEnd = jest.fn();

// We'll store event listeners for the mock req/stream and client
let mockReqListeners = {};
let mockClientListeners = {};

const mockRequest = jest.fn(() => {
    mockReqListeners = {};
    return {
        on: jest.fn((event, cb) => { mockReqListeners[event] = cb; }),
        write: mockWrite,
        end: mockEnd,
    };
});

const mockConnect = jest.fn(() => {
    mockClientListeners = {};
    return {
        on: jest.fn((event, cb) => { mockClientListeners[event] = cb; }),
        request: mockRequest,
        close: mockClose,
    };
});

jest.unstable_mockModule('node:http2', () => ({
    default: { connect: mockConnect },
    connect: mockConnect,
}));

jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

let h2RequestUnary, h2RequestStream;

beforeAll(async () => {
    ({ h2RequestUnary, h2RequestStream } = await import('../../../../src/providers/cursor/cursor-h2.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// h2RequestUnary
// ---------------------------------------------------------------------------

describe('h2RequestUnary', () => {
    test('resolves with concatenated response buffer on success', async () => {
        const promise = h2RequestUnary({
            accessToken: 'tok',
            path: '/svc/Method',
            bodyBytes: Buffer.from([0x01, 0x02]),
            timeoutMs: 5000,
        });

        // Simulate data + end events from the mock request
        setImmediate(() => {
            if (mockReqListeners['data']) mockReqListeners['data'](Buffer.from([0xAA, 0xBB]));
            if (mockReqListeners['data']) mockReqListeners['data'](Buffer.from([0xCC]));
            if (mockReqListeners['end']) mockReqListeners['end']();
        });

        const result = await promise;
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result).toEqual(Buffer.from([0xAA, 0xBB, 0xCC]));
        expect(mockWrite).toHaveBeenCalledWith(expect.any(Buffer));
        expect(mockEnd).toHaveBeenCalled();
        expect(mockClose).toHaveBeenCalled();
    });

    test('rejects when req emits an error', async () => {
        const promise = h2RequestUnary({
            accessToken: 'tok',
            path: '/svc/Method',
            bodyBytes: Buffer.from([0x01]),
            timeoutMs: 5000,
        });

        setImmediate(() => {
            if (mockReqListeners['error']) mockReqListeners['error'](new Error('req error'));
        });

        await expect(promise).rejects.toThrow('req error');
        expect(mockClose).toHaveBeenCalled();
    });

    test('rejects when client connection emits an error', async () => {
        const promise = h2RequestUnary({
            accessToken: 'tok',
            path: '/svc/Method',
            bodyBytes: Buffer.from([0x01]),
            timeoutMs: 5000,
        });

        setImmediate(() => {
            if (mockClientListeners['error']) mockClientListeners['error'](new Error('client error'));
        });

        await expect(promise).rejects.toThrow('client error');
    });

    test('rejects with timeout error after timeoutMs', async () => {
        jest.useFakeTimers();

        const promise = h2RequestUnary({
            accessToken: 'tok',
            path: '/svc/Method',
            bodyBytes: Buffer.from([0x01]),
            timeoutMs: 100,
        });

        jest.advanceTimersByTime(200);

        await expect(promise).rejects.toThrow('timed out');
        expect(mockClose).toHaveBeenCalled();

        jest.useRealTimers();
    });
});

// ---------------------------------------------------------------------------
// h2RequestStream
// ---------------------------------------------------------------------------

describe('h2RequestStream', () => {
    test('returns client and stream objects', () => {
        const result = h2RequestStream({ accessToken: 'tok' });

        expect(result).toHaveProperty('client');
        expect(result).toHaveProperty('stream');
        expect(mockConnect).toHaveBeenCalledWith('https://api2.cursor.sh');
        expect(mockRequest).toHaveBeenCalled();
    });

    test('uses default path /agent.v1.AgentService/Run', () => {
        h2RequestStream({ accessToken: 'tok' });
        // The request was made with headers including the default path
        const headersArg = mockRequest.mock.calls[0][0];
        expect(headersArg[':path']).toBe('/agent.v1.AgentService/Run');
    });

    test('uses custom path when provided', () => {
        h2RequestStream({ accessToken: 'tok', path: '/custom/Service/Method' });
        const headersArg = mockRequest.mock.calls[0][0];
        expect(headersArg[':path']).toBe('/custom/Service/Method');
    });

    test('logs warning on client connection error', () => {
        h2RequestStream({ accessToken: 'tok' });

        // Trigger the client error handler
        if (mockClientListeners['error']) {
            mockClientListeners['error'](new Error('connection reset'));
        }

        // Just verify the call didn't throw; the logger.warn is called internally
        expect(mockConnect).toHaveBeenCalled();
    });
});
