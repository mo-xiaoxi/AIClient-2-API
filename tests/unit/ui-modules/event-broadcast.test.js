/**
 * Unit tests for src/ui-modules/event-broadcast.js
 *
 * Tests: broadcastEvent, handleEvents, initializeUIManagement,
 *        SSE keepalive, client connection management.
 *
 * ESM: jest.unstable_mockModule + dynamic import.
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from '@jest/globals';

// Save original console methods to restore after tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockFsMkdir = jest.fn().mockResolvedValue(undefined);
const mockFsRename = jest.fn().mockResolvedValue(undefined);
const mockFsReadFile = jest.fn().mockResolvedValue('{}');

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

    // Mock fs to allow handleUploadOAuthCredentials success path
    await jest.unstable_mockModule('fs', () => {
        const actual = jest.requireActual('fs');
        return {
            ...actual,
            existsSync: jest.fn(() => false),
            readFileSync: jest.fn(() => '{}'),
            promises: {
                mkdir: mockFsMkdir,
                rename: mockFsRename,
                readFile: mockFsReadFile,
            },
        };
    });

    const mod = await import('../../../src/ui-modules/event-broadcast.js');
    broadcastEvent = mod.broadcastEvent;
    handleEvents = mod.handleEvents;
    initializeUIManagement = mod.initializeUIManagement;
    handleUploadOAuthCredentials = mod.handleUploadOAuthCredentials;
});

// ---------------------------------------------------------------------------
// Module reference
// ---------------------------------------------------------------------------
let broadcastEvent;
let handleEvents;
let initializeUIManagement;
let handleUploadOAuthCredentials;

beforeEach(() => {
    // Reset global event client state between tests
    global.eventClients = [];
    global.logBuffer = [];
    jest.useFakeTimers();
});

afterEach(() => {
    // Clear all pending timers to prevent leaks from handleEvents keepalive intervals
    jest.clearAllTimers();
    jest.useRealTimers();
    // Restore console methods that initializeUIManagement may have overridden
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    global.eventClients = [];
    global.logBuffer = [];
});

afterAll(() => {
    // Final safety restore
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
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

    test('initializes global.eventClients when not present before adding client', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();
        delete global.eventClients;

        await handleEvents(req, res);

        expect(global.eventClients).toBeDefined();
        expect(global.eventClients).toContain(res);
    });

    test('keepalive interval clears when res.writableEnded is true', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();
        global.eventClients = [];

        await handleEvents(req, res);
        expect(global.eventClients).toContain(res);

        res.writableEnded = true;
        jest.advanceTimersByTime(30000);

        expect(global.eventClients).not.toContain(res);
    });

    test('keepalive write succeeds when res is still writable', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();
        global.eventClients = [];

        await handleEvents(req, res);
        // Clear the initial write call count
        res.write.mockClear();

        jest.advanceTimersByTime(30000);

        expect(res.write).toHaveBeenCalledWith(':\n\n');
        expect(global.eventClients).toContain(res);
    });

    test('keepalive interval removes client when write throws', async () => {
        const req = makeFakeReq();
        const res = makeFakeRes();
        global.eventClients = [];

        await handleEvents(req, res);

        // Replace write with one that always throws (interval write will use this)
        res.write.mockImplementation(() => { throw new Error('keepalive write failed'); });

        jest.advanceTimersByTime(30000);

        expect(global.eventClients).not.toContain(res);
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

    test('console.log serializes non-string arguments via JSON.stringify', () => {
        global.logBuffer = [];
        initializeUIManagement();

        console.log({ key: 'value', num: 42 });

        const entry = global.logBuffer[global.logBuffer.length - 1];
        expect(entry.message).toContain('key');
        expect(entry.message).toContain('value');
    });

    test('console.log handles circular reference via String() fallback', () => {
        global.logBuffer = [];
        initializeUIManagement();

        const circular = {};
        circular.self = circular;
        // JSON.stringify throws for circular references
        expect(() => console.log(circular)).not.toThrow();

        const entry = global.logBuffer[global.logBuffer.length - 1];
        expect(entry.message).toBeDefined();
    });

    test('console.error overrides are set and log errors to logBuffer', () => {
        global.logBuffer = [];
        initializeUIManagement();

        console.error('test error message');

        const entry = global.logBuffer[global.logBuffer.length - 1];
        expect(entry.level).toBe('error');
        expect(entry.message).toContain('test error message');
    });

    test('console.error serializes non-string arguments', () => {
        global.logBuffer = [];
        initializeUIManagement();

        console.error({ code: 500, msg: 'server error' });

        const entry = global.logBuffer[global.logBuffer.length - 1];
        expect(entry.level).toBe('error');
        expect(entry.message).toContain('code');
    });

    test('console.error keeps logBuffer at max 100', () => {
        global.logBuffer = new Array(100).fill({ timestamp: '', level: 'error', message: 'old error' });
        initializeUIManagement();

        console.error('overflow error');

        expect(global.logBuffer.length).toBe(100);
    });

    test('console.error handles circular reference via String() fallback', () => {
        global.logBuffer = [];
        initializeUIManagement();

        const circular = {};
        circular.self = circular;
        expect(() => console.error(circular)).not.toThrow();

        const entry = global.logBuffer[global.logBuffer.length - 1];
        expect(entry.message).toBeDefined();
        expect(entry.level).toBe('error');
    });
});

// ---------------------------------------------------------------------------
// handleUploadOAuthCredentials
// ---------------------------------------------------------------------------
describe('handleUploadOAuthCredentials', () => {
    function makeFakeUploadRes() {
        return {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
    }

    test('returns 400 when no file was uploaded', async () => {
        const req = { body: {}, file: undefined };
        const res = makeFakeUploadRes();
        await handleUploadOAuthCredentials(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('No file');
    });

    test('returns 400 when multer reports an upload error', async () => {
        const req = { body: {}, file: undefined };
        const res = makeFakeUploadRes();
        const customUpload = {
            single: jest.fn(() => (_req, _res, cb) => cb(new Error('file too large'))),
        };
        await handleUploadOAuthCredentials(req, res, { customUpload });
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('file too large');
    });

    test('returns 500 when fs.rename throws during file processing', async () => {
        mockFsRename.mockRejectedValueOnce(new Error('rename failed'));
        const res = makeFakeUploadRes();
        const req = { body: {} };
        const customUpload = {
            single: jest.fn(() => (r, _res, cb) => {
                r.file = {
                    path: '/tmp/file_' + Date.now(),
                    originalname: 'test.json',
                    filename: 'ts_test.json',
                };
                r.body = { provider: 'gemini' };
                cb();
            }),
        };
        await handleUploadOAuthCredentials(req, res, { customUpload });
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('rename failed');
    });

    test('handles kiro provider with customUpload (path creation)', async () => {
        const res = makeFakeUploadRes();
        const req = { body: { provider: 'kiro' } };
        const customUpload = {
            single: jest.fn(() => (r, _res, cb) => {
                r.file = {
                    path: '/nonexistent/temp/kiro_file_' + Date.now(),
                    originalname: 'creds.json',
                    filename: 'ts_creds.json',
                };
                r.body = { provider: 'kiro' };
                cb();
            }),
        };
        await handleUploadOAuthCredentials(req, res, { customUpload });
        expect(res.writeHead).toHaveBeenCalled();
    });

    test('successfully uploads file and returns 200', async () => {
        mockFsMkdir.mockResolvedValue(undefined);
        mockFsRename.mockResolvedValue(undefined);
        const res = makeFakeUploadRes();
        const req = { body: {} };
        const customUpload = {
            single: jest.fn(() => (r, _res, cb) => {
                r.file = {
                    path: '/tmp/test_upload_' + Date.now(),
                    originalname: 'credentials.json',
                    filename: 'ts_credentials.json',
                };
                r.body = { provider: 'gemini' };
                cb();
            }),
        };
        global.eventClients = [];
        await handleUploadOAuthCredentials(req, res, { customUpload, logPrefix: '[Test]' });
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.provider).toBe('gemini');
    });

    test('success with userInfo included in log', async () => {
        mockFsMkdir.mockResolvedValue(undefined);
        mockFsRename.mockResolvedValue(undefined);
        const res = makeFakeUploadRes();
        const req = { body: {} };
        const customUpload = {
            single: jest.fn(() => (r, _res, cb) => {
                r.file = {
                    path: '/tmp/test_upload_ui_' + Date.now(),
                    originalname: 'token.json',
                    filename: 'ts_token.json',
                };
                r.body = { provider: 'kiro' };
                cb();
            }),
        };
        global.eventClients = [];
        await handleUploadOAuthCredentials(req, res, { customUpload, userInfo: 'user@example.com' });
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });
});
