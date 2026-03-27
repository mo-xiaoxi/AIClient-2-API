/**
 * Unit tests for parseConnectErrorFrame and CONNECT_ERROR_HTTP_MAP in cursor-h2.js
 *
 * Tests:
 * - unauthenticated → 401
 * - resource_exhausted → 429
 * - invalid_argument → 400
 * - unknown code → 502 fallback
 * - no error field → null
 * - JSON parse failure → 502 fallback
 * - CONNECT_ERROR_HTTP_MAP completeness
 */

import { describe, test, expect } from '@jest/globals';
import {
    parseConnectErrorFrame,
    CONNECT_ERROR_HTTP_MAP,
} from '../../../../src/providers/cursor/cursor-h2.js';

// ============================================================================
// CONNECT_ERROR_HTTP_MAP
// ============================================================================

describe('CONNECT_ERROR_HTTP_MAP', () => {
    test('maps unauthenticated to 401', () => {
        expect(CONNECT_ERROR_HTTP_MAP['unauthenticated']).toBe(401);
    });

    test('maps permission_denied to 403', () => {
        expect(CONNECT_ERROR_HTTP_MAP['permission_denied']).toBe(403);
    });

    test('maps not_found to 404', () => {
        expect(CONNECT_ERROR_HTTP_MAP['not_found']).toBe(404);
    });

    test('maps resource_exhausted to 429', () => {
        expect(CONNECT_ERROR_HTTP_MAP['resource_exhausted']).toBe(429);
    });

    test('maps invalid_argument to 400', () => {
        expect(CONNECT_ERROR_HTTP_MAP['invalid_argument']).toBe(400);
    });

    test('maps failed_precondition to 400', () => {
        expect(CONNECT_ERROR_HTTP_MAP['failed_precondition']).toBe(400);
    });

    test('maps unimplemented to 501', () => {
        expect(CONNECT_ERROR_HTTP_MAP['unimplemented']).toBe(501);
    });

    test('maps unavailable to 503', () => {
        expect(CONNECT_ERROR_HTTP_MAP['unavailable']).toBe(503);
    });

    test('maps internal to 500', () => {
        expect(CONNECT_ERROR_HTTP_MAP['internal']).toBe(500);
    });

    test('maps unknown to 502', () => {
        expect(CONNECT_ERROR_HTTP_MAP['unknown']).toBe(502);
    });

    test('maps canceled to 499', () => {
        expect(CONNECT_ERROR_HTTP_MAP['canceled']).toBe(499);
    });

    test('maps deadline_exceeded to 504', () => {
        expect(CONNECT_ERROR_HTTP_MAP['deadline_exceeded']).toBe(504);
    });

    test('contains all expected keys', () => {
        const expectedKeys = [
            'unauthenticated',
            'permission_denied',
            'not_found',
            'resource_exhausted',
            'invalid_argument',
            'failed_precondition',
            'unimplemented',
            'unavailable',
            'internal',
            'unknown',
            'canceled',
            'deadline_exceeded',
        ];
        for (const key of expectedKeys) {
            expect(CONNECT_ERROR_HTTP_MAP).toHaveProperty(key);
        }
    });
});

// ============================================================================
// parseConnectErrorFrame
// ============================================================================

describe('parseConnectErrorFrame', () => {
    function makeFrameBytes(payload) {
        return new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8'));
    }

    // --- Happy path: known error codes ---

    test('unauthenticated error → httpStatus 401', () => {
        const data = makeFrameBytes({ error: { code: 'unauthenticated', message: 'Token invalid' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(401);
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.status).toBe(401);
        expect(result.error.connectCode).toBe('unauthenticated');
    });

    test('resource_exhausted error → httpStatus 429', () => {
        const data = makeFrameBytes({ error: { code: 'resource_exhausted', message: 'Rate limit hit' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(429);
        expect(result.error.status).toBe(429);
        expect(result.error.connectCode).toBe('resource_exhausted');
    });

    test('invalid_argument error → httpStatus 400', () => {
        const data = makeFrameBytes({ error: { code: 'invalid_argument', message: 'Bad input' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(400);
        expect(result.error.status).toBe(400);
        expect(result.error.connectCode).toBe('invalid_argument');
    });

    test('internal error → httpStatus 500', () => {
        const data = makeFrameBytes({ error: { code: 'internal', message: 'Server exploded' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(500);
    });

    test('unavailable error → httpStatus 503', () => {
        const data = makeFrameBytes({ error: { code: 'unavailable', message: 'Service down' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(503);
    });

    test('deadline_exceeded error → httpStatus 504', () => {
        const data = makeFrameBytes({ error: { code: 'deadline_exceeded', message: 'Timed out' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(504);
    });

    // --- Fallback for unknown codes ---

    test('unrecognised code falls back to httpStatus 502', () => {
        const data = makeFrameBytes({ error: { code: 'totally_unknown_code', message: 'Weird error' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(502);
        expect(result.error.status).toBe(502);
        expect(result.error.connectCode).toBe('totally_unknown_code');
    });

    test('missing code field falls back to unknown → 502', () => {
        const data = makeFrameBytes({ error: { message: 'No code provided' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(502);
        expect(result.error.connectCode).toBe('unknown');
    });

    // --- Error message extraction ---

    test('uses detail from nested debug.details.detail when available', () => {
        const data = makeFrameBytes({
            error: {
                code: 'internal',
                message: 'Generic message',
                details: [{ debug: { details: { detail: 'Specific detail from debug' } } }],
            },
        });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.error.message).toBe('Specific detail from debug');
    });

    test('falls back to error.message when debug.details.detail is absent', () => {
        const data = makeFrameBytes({ error: { code: 'internal', message: 'Fallback message' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.error.message).toBe('Fallback message');
    });

    test('falls back to "Unknown error" when message is absent', () => {
        const data = makeFrameBytes({ error: { code: 'internal' } });
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.error.message).toBe('Unknown error');
    });

    // --- No error field → null ---

    test('returns null when JSON has no error field', () => {
        const data = makeFrameBytes({});
        expect(parseConnectErrorFrame(data)).toBeNull();
    });

    test('returns null when JSON has metadata but no error', () => {
        const data = makeFrameBytes({ metadata: { foo: 'bar' } });
        expect(parseConnectErrorFrame(data)).toBeNull();
    });

    test('returns null for empty end-stream frame (empty JSON object)', () => {
        const data = makeFrameBytes({});
        expect(parseConnectErrorFrame(data)).toBeNull();
    });

    // --- JSON parse failure → 502 fallback ---

    test('returns 502 fallback on non-JSON bytes', () => {
        const data = new Uint8Array([0x00, 0x01, 0x02, 0xFF]);
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(502);
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.status).toBe(502);
    });

    test('returns 502 fallback on empty buffer', () => {
        const data = new Uint8Array(0);
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(502);
    });

    test('returns 502 fallback on truncated JSON', () => {
        const data = new Uint8Array(Buffer.from('{"error": {"code":', 'utf8'));
        const result = parseConnectErrorFrame(data);
        expect(result).not.toBeNull();
        expect(result.httpStatus).toBe(502);
    });

    // --- Return shape ---

    test('result has both error and httpStatus keys', () => {
        const data = makeFrameBytes({ error: { code: 'internal', message: 'oops' } });
        const result = parseConnectErrorFrame(data);
        expect(result).toHaveProperty('error');
        expect(result).toHaveProperty('httpStatus');
    });

    test('error has status and connectCode properties attached', () => {
        const data = makeFrameBytes({ error: { code: 'not_found', message: 'Not found' } });
        const result = parseConnectErrorFrame(data);
        expect(result.error.status).toBe(404);
        expect(result.error.connectCode).toBe('not_found');
    });
});
