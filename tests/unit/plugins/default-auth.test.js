/**
 * Unit tests for plugins/default-auth/index.js
 *
 * Tests: authenticate() — Authorization Bearer, x-api-key, x-goog-api-key,
 *        URL query param, missing key, wrong key.
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let defaultAuthPlugin;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    const mod = await import('../../../src/plugins/default-auth/index.js');
    defaultAuthPlugin = mod.default;
});

// Helpers to build minimal mock req/res/url objects
function makeReq(headers = {}) {
    return { headers };
}

function makeUrl(queryParams = {}) {
    const params = new URLSearchParams(queryParams);
    const url = new URL(`http://localhost/v1/chat/completions?${params.toString()}`);
    return url;
}

function makeRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
    };
}

const REQUIRED_KEY = 'test-secret-key';
const config = { REQUIRED_API_KEY: REQUIRED_KEY };

// =============================================================================
// Plugin metadata
// =============================================================================

describe('defaultAuthPlugin metadata', () => {
    test('has correct name', () => {
        expect(defaultAuthPlugin.name).toBe('default-auth');
    });

    test('has type auth', () => {
        expect(defaultAuthPlugin.type).toBe('auth');
    });

    test('is marked as builtin', () => {
        expect(defaultAuthPlugin._builtin).toBe(true);
    });

    test('has authenticate function', () => {
        expect(typeof defaultAuthPlugin.authenticate).toBe('function');
    });
});

// =============================================================================
// Authorization Bearer header
// =============================================================================

describe('Authorization Bearer header', () => {
    test('returns authorized: true for correct Bearer token', async () => {
        const req = makeReq({ authorization: `Bearer ${REQUIRED_KEY}` });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBe(true);
    });

    test('returns authorized: null for wrong Bearer token', async () => {
        const req = makeReq({ authorization: 'Bearer wrong-key' });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBeNull();
    });

    test('returns authorized: null when Authorization header is missing', async () => {
        const req = makeReq({});
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBeNull();
    });

    test('never sets handled: true (lets request-handler respond)', async () => {
        const req = makeReq({ authorization: `Bearer ${REQUIRED_KEY}` });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.handled).toBe(false);
    });
});

// =============================================================================
// x-api-key header (Claude style)
// =============================================================================

describe('x-api-key header', () => {
    test('returns authorized: true for correct x-api-key', async () => {
        const req = makeReq({ 'x-api-key': REQUIRED_KEY });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBe(true);
    });

    test('returns authorized: null for wrong x-api-key', async () => {
        const req = makeReq({ 'x-api-key': 'bad-key' });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBeNull();
    });
});

// =============================================================================
// x-goog-api-key header (Gemini style)
// =============================================================================

describe('x-goog-api-key header', () => {
    test('returns authorized: true for correct x-goog-api-key', async () => {
        const req = makeReq({ 'x-goog-api-key': REQUIRED_KEY });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBe(true);
    });

    test('returns authorized: null for wrong x-goog-api-key', async () => {
        const req = makeReq({ 'x-goog-api-key': 'bad-key' });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBeNull();
    });
});

// =============================================================================
// URL query parameter (Gemini style ?key=)
// =============================================================================

describe('URL query key parameter', () => {
    test('returns authorized: true for correct key query param', async () => {
        const req = makeReq({});
        const url = makeUrl({ key: REQUIRED_KEY });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), url, config);
        expect(result.authorized).toBe(true);
    });

    test('returns authorized: null for wrong key query param', async () => {
        const req = makeReq({});
        const url = makeUrl({ key: 'wrong' });
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), url, config);
        expect(result.authorized).toBeNull();
    });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
    test('returns authorized: null when no credential provided at all', async () => {
        const req = makeReq({});
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBeNull();
    });

    test('Bearer prefix mismatch does not grant access', async () => {
        const req = makeReq({ authorization: REQUIRED_KEY }); // no "Bearer " prefix
        const result = await defaultAuthPlugin.authenticate(req, makeRes(), makeUrl(), config);
        expect(result.authorized).toBeNull();
    });
});
