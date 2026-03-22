/**
 * UI Module: system-api.js Tests
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
    default: {},
    initTlsSidecar: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        currentLogFile: null,
        clearTodayLog: jest.fn(() => true),
    },
}));

jest.unstable_mockModule('../../../src/ui-modules/system-monitor.js', () => ({
    getCpuUsagePercent: jest.fn(() => '5.0%'),
}));

jest.unstable_mockModule('../../../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn(),
}));

jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: jest.fn(() => false),
        readFileSync: jest.fn(() => '1.0.0'),
        createReadStream: jest.fn(() => ({
            pipe: jest.fn(),
        })),
    };
});

function createMockRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
    };
}

let handleGetSystem;
let handleDownloadTodayLog;
let handleClearTodayLog;
let handleHealthCheck;
let handleGetServiceMode;
let handleRestartService;

beforeAll(async () => {
    ({
        handleGetSystem,
        handleDownloadTodayLog,
        handleClearTodayLog,
        handleHealthCheck,
        handleGetServiceMode,
        handleRestartService,
    } = await import('../../../src/ui-modules/system-api.js'));
});

describe('system-api.js - handleGetSystem', () => {
    test('returns 200 with system info fields', async () => {
        const req = {};
        const res = createMockRes();
        await handleGetSystem(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body).toHaveProperty('nodeVersion');
        expect(body).toHaveProperty('serverTime');
        expect(body).toHaveProperty('memoryUsage');
        expect(body).toHaveProperty('uptime');
        expect(body).toHaveProperty('cpuUsage');
    });

    test('appVersion is unknown when VERSION file does not exist', async () => {
        const req = {};
        const res = createMockRes();
        await handleGetSystem(req, res);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        // existsSync is mocked to return false
        expect(body.appVersion).toBe('unknown');
    });
});

describe('system-api.js - handleDownloadTodayLog', () => {
    test('returns 404 when no log file exists', async () => {
        const req = {};
        const res = createMockRes();
        await handleDownloadTodayLog(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('not found');
    });
});

describe('system-api.js - handleClearTodayLog', () => {
    test('returns 200 when log is cleared successfully', async () => {
        const req = {};
        const res = createMockRes();
        await handleClearTodayLog(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
    });
});

describe('system-api.js - handleHealthCheck', () => {
    test('returns 200 with ok status', async () => {
        const req = {};
        const res = createMockRes();
        await handleHealthCheck(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.status).toBe('ok');
        expect(body.timestamp).toBeDefined();
    });
});

describe('system-api.js - handleGetServiceMode', () => {
    test('returns standalone mode info when not a worker', async () => {
        delete process.env.IS_WORKER_PROCESS;
        const req = {};
        const res = createMockRes();
        await handleGetServiceMode(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.mode).toBe('standalone');
        expect(body.pid).toBeDefined();
        expect(body.nodeVersion).toBe(process.version);
    });
});

describe('system-api.js - handleRestartService', () => {
    test('returns 400 in standalone mode (no auto-restart)', async () => {
        delete process.env.IS_WORKER_PROCESS;
        const req = {};
        const res = createMockRes();
        await handleRestartService(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
        expect(body.mode).toBe('standalone');
    });
});
