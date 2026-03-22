/**
 * UI Module: auth.js Tests
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

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
    },
}));

// Mock fs to avoid actual file reads
jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: jest.fn(() => false),
        promises: {
            readFile: jest.fn().mockRejectedValue({ code: 'ENOENT' }),
            writeFile: jest.fn().mockResolvedValue(undefined),
        },
    };
});

// Mock config-manager
jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
    CONFIG: {
        LOGIN_EXPIRY: 3600,
        LOGIN_MIN_INTERVAL: 0,
        LOGIN_MAX_ATTEMPTS: 5,
        LOGIN_LOCKOUT_DURATION: 1800,
    },
}));

// Mock common.js - use unique IPs per test to avoid rate limiting
let mockIpCounter = 0;
jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    getClientIp: jest.fn(() => `192.168.1.${++mockIpCounter}`),
    MODEL_PROTOCOL_PREFIX: {},
}));

// Helper to create mock req/res
function createMockRes() {
    const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
    };
    return res;
}

function createMockReq(method = 'POST', body = null) {
    const EventEmitter = jest.requireActual('events');
    const req = new EventEmitter.EventEmitter();
    req.method = method;
    req.headers = { authorization: undefined };
    req.url = '/api/auth/login';

    // Simulate body streaming
    if (body !== null) {
        process.nextTick(() => {
            req.emit('data', JSON.stringify(body));
            req.emit('end');
        });
    } else {
        process.nextTick(() => {
            req.emit('end');
        });
    }

    return req;
}

let handleLoginRequest;
let validateCredentials;
let readPasswordFile;
let checkAuth;
let verifyToken;

beforeAll(async () => {
    ({ handleLoginRequest, validateCredentials, readPasswordFile, checkAuth, verifyToken } =
        await import('../../../src/ui-modules/auth.js'));
});

describe('auth.js - readPasswordFile', () => {
    test('returns default password when file does not exist', async () => {
        const password = await readPasswordFile();
        expect(password).toBe('admin123');
    });
});

describe('auth.js - validateCredentials', () => {
    test('validates correct default password', async () => {
        const isValid = await validateCredentials('admin123');
        expect(isValid).toBe(true);
    });

    test('rejects incorrect password', async () => {
        const isValid = await validateCredentials('wrong-password');
        expect(isValid).toBe(false);
    });

    test('rejects empty password', async () => {
        const isValid = await validateCredentials('');
        expect(isValid).toBe(false);
    });
});

describe('auth.js - handleLoginRequest', () => {
    test('rejects GET method with 405', async () => {
        const req = createMockReq('GET');
        const res = createMockRes();
        await handleLoginRequest(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });

    test('rejects request with empty password with 400', async () => {
        const req = createMockReq('POST', {});
        const res = createMockRes();
        await handleLoginRequest(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });

    test('returns 200 with token on correct password', async () => {
        const req = createMockReq('POST', { password: 'admin123' });
        const res = createMockRes();
        await handleLoginRequest(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        expect(body.token).toBeDefined();
        expect(typeof body.token).toBe('string');
    });

    test('returns 401 with incorrect password', async () => {
        const req = createMockReq('POST', { password: 'wrongpassword' });
        const res = createMockRes();
        await handleLoginRequest(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });
});

describe('auth.js - checkAuth', () => {
    test('returns false when no authorization header', async () => {
        const req = { headers: {} };
        const result = await checkAuth(req);
        expect(result).toBe(false);
    });

    test('returns false when authorization header does not start with Bearer', async () => {
        const req = { headers: { authorization: 'Basic sometoken' } };
        const result = await checkAuth(req);
        expect(result).toBe(false);
    });

    test('returns false for non-existent token', async () => {
        const req = { headers: { authorization: 'Bearer nonexistenttoken123' } };
        const result = await checkAuth(req);
        expect(result).toBe(false);
    });
});
