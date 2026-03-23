/**
 * Unit tests for cursor-h2.js
 *
 * Tests: buildCursorH2Headers, frameConnectMessage, parseConnectFrame,
 *        CONNECT_END_STREAM_FLAG constant.
 */

import { describe, test, expect } from '@jest/globals';
import {
    buildCursorH2Headers,
    frameConnectMessage,
    parseConnectFrame,
    CONNECT_END_STREAM_FLAG,
} from '../../../../src/providers/cursor/cursor-h2.js';

// ============================================================================
// CONNECT_END_STREAM_FLAG
// ============================================================================

describe('CONNECT_END_STREAM_FLAG', () => {
    test('equals 0x02', () => {
        expect(CONNECT_END_STREAM_FLAG).toBe(0x02);
    });
});

// ============================================================================
// buildCursorH2Headers
// ============================================================================

describe('buildCursorH2Headers', () => {
    test('returns correct HTTP/2 headers', () => {
        const headers = buildCursorH2Headers('test-token-123', '/agent.v1.AgentService/Run');

        expect(headers[':method']).toBe('POST');
        expect(headers[':path']).toBe('/agent.v1.AgentService/Run');
        expect(headers['content-type']).toBe('application/connect+proto');
        expect(headers['connect-protocol-version']).toBe('1');
        expect(headers['te']).toBe('trailers');
        expect(headers['authorization']).toBe('Bearer test-token-123');
        expect(headers['x-ghost-mode']).toBe('true');
        expect(headers['x-cursor-client-type']).toBe('cli');
    });

    test('includes x-cursor-client-version', () => {
        const headers = buildCursorH2Headers('token', '/path');
        expect(headers['x-cursor-client-version']).toMatch(/^cli-/);
    });

    test('generates unique x-request-id per call', () => {
        const h1 = buildCursorH2Headers('t', '/p');
        const h2 = buildCursorH2Headers('t', '/p');
        expect(h1['x-request-id']).toBeDefined();
        expect(h2['x-request-id']).toBeDefined();
        expect(h1['x-request-id']).not.toBe(h2['x-request-id']);
    });

    test('uses the provided access token', () => {
        const headers = buildCursorH2Headers('my-secret-token', '/run');
        expect(headers['authorization']).toBe('Bearer my-secret-token');
    });

    test('uses the provided path', () => {
        const headers = buildCursorH2Headers('t', '/agent.v1.AgentService/GetUsableModels');
        expect(headers[':path']).toBe('/agent.v1.AgentService/GetUsableModels');
    });
});

// ============================================================================
// frameConnectMessage
// ============================================================================

describe('frameConnectMessage', () => {
    test('creates frame with 5-byte header', () => {
        const data = Buffer.from([0x01, 0x02, 0x03]);
        const frame = frameConnectMessage(data);

        expect(frame.length).toBe(8); // 5 header + 3 data
        expect(frame[0]).toBe(0); // flags = 0
        expect(frame.readUInt32BE(1)).toBe(3); // length
        expect(frame[5]).toBe(0x01);
        expect(frame[6]).toBe(0x02);
        expect(frame[7]).toBe(0x03);
    });

    test('sets flags byte correctly', () => {
        const frame = frameConnectMessage(Buffer.from([0xFF]), 0x02);
        expect(frame[0]).toBe(0x02);
    });

    test('handles large payload', () => {
        const data = Buffer.alloc(1000, 0xAB);
        const frame = frameConnectMessage(data);
        expect(frame.length).toBe(1005);
        expect(frame.readUInt32BE(1)).toBe(1000);
        expect(frame[5]).toBe(0xAB);
        expect(frame[1004]).toBe(0xAB);
    });

    test('handles Uint8Array input', () => {
        const data = new Uint8Array([10, 20, 30]);
        const frame = frameConnectMessage(data);
        expect(frame.length).toBe(8);
        expect(frame.subarray(5)).toEqual(Buffer.from([10, 20, 30]));
    });

    test('round-trips with frame parsing', () => {
        const original = Buffer.from('test data for round trip');
        const frame = frameConnectMessage(original);

        // Parse it back
        const flags = frame[0];
        const len = frame.readUInt32BE(1);
        const payload = frame.subarray(5, 5 + len);

        expect(flags).toBe(0);
        expect(payload.toString()).toBe('test data for round trip');
    });
});

// ============================================================================
// parseConnectFrame
// ============================================================================

describe('parseConnectFrame', () => {
    test('returns null for non-error JSON', () => {
        const data = Buffer.from(JSON.stringify({}));
        expect(parseConnectFrame(data)).toBeNull();
    });

    test('returns null for JSON with metadata but no error', () => {
        const data = Buffer.from(JSON.stringify({ metadata: { foo: 'bar' } }));
        expect(parseConnectFrame(data)).toBeNull();
    });

    test('returns Error for Connect error with code and message', () => {
        const data = Buffer.from(JSON.stringify({
            error: { code: 'unauthenticated', message: 'Invalid token' },
        }));
        const err = parseConnectFrame(data);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('unauthenticated');
        expect(err.message).toContain('Invalid token');
    });

    test('returns Error for Connect error with only code', () => {
        const data = Buffer.from(JSON.stringify({
            error: { code: 'internal' },
        }));
        const err = parseConnectFrame(data);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('internal');
    });

    test('returns Error for Connect error with empty object', () => {
        const data = Buffer.from(JSON.stringify({ error: {} }));
        const err = parseConnectFrame(data);
        expect(err).toBeInstanceOf(Error);
    });

    test('returns Error for non-JSON data', () => {
        const err = parseConnectFrame(Buffer.from([0x00, 0x01, 0x02]));
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('Failed to parse');
    });

    test('returns Error for empty buffer', () => {
        const err = parseConnectFrame(Buffer.alloc(0));
        expect(err).toBeInstanceOf(Error);
    });
});
