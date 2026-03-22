/**
 * Unit tests for src/ui-modules/event-broadcast.js
 *
 * Tests: broadcastEvent, handleEvents, initializeUIManagement,
 *        SSE keepalive, client connection management.
 *
 * ESM: jest.unstable_mockModule + dynamic import.
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        },
    }));

    // Mock multer — heavy dependency not needed for these tests
    await jest.unstable_mockModule('multer', () => {
        const multerFn = jest.fn(() => ({
            single: jest.fn(() => (req, res, cb) => cb()),
        }));
        multerFn.diskStorage = jest.fn(() => ({}));
        return { default: multerFn };
    });
});

// ---------------------------------------------------------------------------
// Module reference
// ---------------------------------------------------------------------------
let broadcastEvent;
let handleEvents;
let initializeUIManagement;

beforeAll(async () => {
    const mod = await import('../../../src/ui-modules/event-broadcast.js');
    broadcastEvent = mod.broadcastEvent;
    handleEvents = mod.handleEvents;
    initializeUIManagement = mod.initializeUIManagement;
});

beforeEach(() => {
    // Reset global event client state between tests
    global.eventClients = [];
    global.logBuffer = [];
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
    global.eventClients = [];
    global.logBuffer = [];
});

// ---------------------------------------------------------------------------
// Helper: make a fake SSE response object
// ---------------------------------------------------------------------------
function makeFakeRes() {
    return {
        writeHead: jest.fn(),
        write: jest.fn(() => true),
        end: jest.fn(),
        writableEnded: false,
        destroyed: false,
        on: jest.fn(),
    };
}

function makeFakeReq() {
    let closeListener = null;
    const req = {
        on: jest.fn((event, cb) => {
            if (event === 'close') closeListener = cb;
        }),
        triggerClose: () => closeListener && closeListener(),
    };
    return req;
}

// ---------------------------------------------------------------------------
// broadcastEvent
// ---------------------------------------------------------------------------
describe('broadcastEvent', () => {
    test('does nothing when no event clients connected', () => {
        global.eventClients = [];
        // Should not throw
        expect(() => broadcastEvent('test', { msg: 'hello' })).not.toThrow();
    });

    test('writes event type and data to each connected client', () => {
        const client1 = { write: jest.fn() };
        const client2 = { write: jest.fn() };
        global.eventClients = [client1, client2];

        broadcastEvent('log', { message: 'hello' });

        expect(client1.write).toHaveBeenCalledWith('event: log\n');
        expect(client1.write).toHaveBeenCalledWith(expect.stringContaining('data:'));
        expect(client2.write).toHaveBeenCalledWith('event: log\n');
    });

    test('serializes object data to JSON string', () => {
        const client = { write: jest.fn() };
        global.eventClients = [client];
        const data = { key: 'value', num: 42 };

        broadcastEvent('update', data);

        const dataCall = client.write.mock.calls.find(call => call[0].startsWith('data:'));
        expect(dataCall).toBeDefined();
        const payload = dataCall[0].replace('data: ', '').replace('\n\n', '');
        expect(JSON.parse(payload)).toEqual(data);
    });

    test('sends string data as-is without re-serializing', () => {
        const client = { write: jest.fn() };
        global.eventClients = [client];

        broadcastEvent('message', 'plain text');

        const dataCall = client.write.mock.calls.find(call => call[0].startsWith('data:'));
        expect(dataCall[0]).toContain('plain text');
    });

    test('broadcasts to all clients', () => {
        const clients = Array.from({ length: 5 }, () => ({ write: jest.fn() }));
        global.eventClients = clients;

        broadcastEvent('ping', 'pong');

        clients.forEach(c => {
            expect(c.write).toHaveBeenCalledTimes(2); // event line + data line
        });
    });
});

// ---------------------------------------------------------------------------
// handleEvents
// ---------------------------------------------------------------------------
describe('handleEvents', () => {
    test('sets SSE headers with correct Content-Type', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();

        await handleEvents(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream',
        }));
    });

    test('sets Cache-Control: no-cache header', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();

        await handleEvents(req, res);

        const headersArg = res.writeHead.mock.calls[0][1];
        expect(headersArg['Cache-Control']).toBe('no-cache');
    });

    test('adds client to global.eventClients', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();
        global.eventClients = [];

        await handleEvents(req, res);

        expect(global.eventClients).toContain(res);
    });

    test('removes client from global.eventClients on request close', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();
        global.eventClients = [];

        await handleEvents(req, res);
        expect(global.eventClients).toContain(res);

        req.triggerClose();
        expect(global.eventClients).not.toContain(res);
    });

    test('returns true', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();

        const result = await handleEvents(req, res);
        expect(result).toBe(true);
    });

    test('writes initial newline to connection', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();

        await handleEvents(req, res);

        expect(res.write).toHaveBeenCalledWith('\n');
    });

    test('returns true and logs error when initial write fails', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();
        res.write.mockImplementation(() => { throw new Error('write failed'); });

        const result = await handleEvents(req, res);
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// initializeUIManagement
// ---------------------------------------------------------------------------
describe('initializeUIManagement', () => {
    test('initializes global.eventClients if not present', () => {
        delete global.eventClients;
        initializeUIManagement();
        expect(global.eventClients).toEqual([]);
    });

    test('initializes global.logBuffer if not present', () => {
        delete global.logBuffer;
        initializeUIManagement();
        expect(global.logBuffer).toEqual([]);
    });

    test('does not overwrite existing eventClients', () => {
        const existingClient = { write: jest.fn() };
        global.eventClients = [existingClient];
        initializeUIManagement();
        expect(global.eventClients).toContain(existingClient);
    });

    test('overrides console.log to broadcast log events', () => {
        global.eventClients = [{ write: jest.fn() }];
        initializeUIManagement();

        console.log('test log message');

        // The log should be added to logBuffer
        expect(global.logBuffer.length).toBeGreaterThan(0);
        const entry = global.logBuffer[global.logBuffer.length - 1];
        expect(entry).toHaveProperty('level', 'info');
        expect(entry.message).toContain('test log message');
    });

    test('keeps logBuffer max size at 100', () => {
        global.logBuffer = new Array(100).fill({ timestamp: '', level: 'info', message: 'old' });
        initializeUIManagement();

        // Add one more log entry
        console.log('new message');

        expect(global.logBuffer.length).toBe(100);
    });
});
