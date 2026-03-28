/**
 * UI Module: auth.js Tests
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

// Must match DEFAULT_PASSWORD in src/ui-modules/auth.js
const DEFAULT_PASSWORD = 'admin123';

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

// Mock fs — default: file not found; override per-test as needed
const mockReadFile = jest.fn().mockRejectedValue({ code: 'ENOENT' });
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
const mockExistsSync = jest.fn(() => false);
jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: mockExistsSync,
        promises: {
            readFile: mockReadFile,
            writeFile: mockWriteFile,
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

beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    mockWriteFile.mockResolvedValue(undefined);
});

describe('auth.js - readPasswordFile', () => {
    test('returns default password when file does not exist', async () => {
        const password = await readPasswordFile();
        expect(password).toBe(DEFAULT_PASSWORD);
    });

    test('returns custom password when file exists', async () => {
        mockReadFile.mockResolvedValueOnce('my-custom-password\n');
        const password = await readPasswordFile();
        expect(password).toBe('my-custom-password');
    });
});

describe('auth.js - validateCredentials', () => {
    test('validates correct default password', async () => {
        const isValid = await validateCredentials(DEFAULT_PASSWORD);
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
        const req = createMockReq('POST', { password: DEFAULT_PASSWORD });
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

    test('returns true when token is valid and not expired', async () => {
        const tokenStore = {
            tokens: {
                'valid-bearer-tok': {
                    username: 'admin',
                    loginTime: Date.now(),
                    expiryTime: Date.now() + 3600000,
                },
            },
        };
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify(tokenStore));
        const req = { headers: { authorization: 'Bearer valid-bearer-tok' } };
        const result = await checkAuth(req);
        expect(result).toBe(true);
    });
});

// =============================================================================
// readPasswordFile — additional branches
// =============================================================================

describe('auth.js - readPasswordFile (additional branches)', () => {
    test('returns default password when file is empty', async () => {
        mockReadFile.mockResolvedValueOnce('   ');
        const password = await readPasswordFile();
        expect(password).toBe(DEFAULT_PASSWORD);
    });

    test('returns default password on non-ENOENT fs error', async () => {
        mockReadFile.mockRejectedValueOnce({ code: 'EPERM', message: 'Permission denied' });
        const password = await readPasswordFile();
        expect(password).toBe(DEFAULT_PASSWORD);
    });
});

// =============================================================================
// parseRequestBody — via handleLoginRequest
// =============================================================================

describe('auth.js - parseRequestBody (via handleLoginRequest)', () => {
    test('handles empty body (no data chunks) → 400 empty password', async () => {
        // createMockReq with null body emits 'end' with no 'data' → body='' → resolve({})
        const req = createMockReq('POST', null);
        const res = createMockRes();
        await handleLoginRequest(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });

    test('returns 500 on invalid JSON body', async () => {
        const EventEmitter = jest.requireActual('events');
        const req = new EventEmitter.EventEmitter();
        req.method = 'POST';
        req.headers = {};
        req.url = '/api/auth/login';
        process.nextTick(() => {
            req.emit('data', '{not: valid json!!}');
            req.emit('end');
        });
        const res = createMockRes();
        await handleLoginRequest(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(false);
    });
});

// =============================================================================
// readTokenStore — via verifyToken
// =============================================================================

describe('auth.js - readTokenStore (via verifyToken)', () => {
    test('reads token store from existing file and returns token info', async () => {
        const tokenStore = {
            tokens: {
                'file-token': {
                    username: 'admin',
                    loginTime: Date.now(),
                    expiryTime: Date.now() + 3600000,
                },
            },
        };
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify(tokenStore));
        const result = await verifyToken('file-token');
        expect(result).not.toBeNull();
        expect(result.username).toBe('admin');
    });

    test('returns null (empty store) when readFile throws while file exists', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockRejectedValueOnce(new Error('disk read error'));
        const result = await verifyToken('any-token');
        expect(result).toBeNull();
    });
});

// =============================================================================
// writeTokenStore error path
// =============================================================================

describe('auth.js - writeTokenStore error path', () => {
    test('login still returns 200 even when token save write fails', async () => {
        // existsSync=false: readTokenStore writes default store (write #1 succeeds)
        // saveToken then writes updated store (write #2 fails silently)
        mockExistsSync.mockReturnValue(false);
        mockWriteFile
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('disk full'));
        const req = createMockReq('POST', { password: DEFAULT_PASSWORD });
        const res = createMockRes();
        await handleLoginRequest(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
    });
});

// =============================================================================
// verifyToken — expired token path
// =============================================================================

describe('auth.js - verifyToken expired token', () => {
    test('returns null and deletes expired token from store', async () => {
        const expiredStore = {
            tokens: {
                'expired-tok': {
                    username: 'admin',
                    loginTime: 1,
                    expiryTime: 1, // already in the past
                },
            },
        };
        mockExistsSync.mockReturnValue(true);
        // First readFile for verifyToken, second for deleteToken's readTokenStore
        mockReadFile.mockResolvedValue(JSON.stringify(expiredStore));
        const result = await verifyToken('expired-tok');
        expect(result).toBeNull();
        // writeFile should be called to persist the deletion
        expect(mockWriteFile).toHaveBeenCalled();
    });
});
