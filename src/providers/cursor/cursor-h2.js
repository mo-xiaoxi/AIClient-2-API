/**
 * cursor-h2.js
 *
 * HTTP/2 transport layer for Cursor API communication.
 * Implements Connect Protocol over HTTP/2 for unary and streaming RPC.
 */

import http2 from 'node:http2';
import { randomUUID } from 'node:crypto';

const CURSOR_API_URL = 'https://api2.cursor.sh';
const CURSOR_CLIENT_VERSION = 'cli-2026.02.13-41ac335';

// Connect Protocol constants
export const CONNECT_END_STREAM_FLAG = 0x02;

/**
 * Build standard Cursor HTTP/2 request headers.
 * @param {string} accessToken
 * @param {string} path - e.g. '/agent.v1.AgentService/Run'
 * @returns {object}
 */
export function buildCursorH2Headers(accessToken, path) {
    return {
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/connect+proto',
        'connect-protocol-version': '1',
        'te': 'trailers',
        'authorization': `Bearer ${accessToken}`,
        'x-ghost-mode': 'true',
        'x-cursor-client-version': CURSOR_CLIENT_VERSION,
        'x-cursor-client-type': 'cli',
        'x-request-id': randomUUID(),
    };
}

/**
 * Frame data in Connect Protocol format (5-byte header + data).
 * @param {Uint8Array|Buffer} data
 * @param {number} flags - default 0 (regular message)
 * @returns {Buffer}
 */
export function frameConnectMessage(data, flags = 0) {
    const frame = Buffer.alloc(5 + data.length);
    frame[0] = flags;
    frame.writeUInt32BE(data.length, 1);
    frame.set(data, 5);
    return frame;
}

/**
 * Parse a Connect End Stream frame.
 * @param {Uint8Array} data - the raw bytes after the 5-byte header
 * @returns {Error|null} - null if no error, Error if error present
 */
export function parseConnectFrame(data) {
    try {
        const text = new TextDecoder().decode(data);
        const p = JSON.parse(text);
        if (p?.error) {
            return new Error(`Connect error ${p.error.code ?? 'unknown'}: ${p.error.message ?? 'Unknown'}`);
        }
        return null;
    } catch {
        return new Error('Failed to parse Connect end stream');
    }
}

/**
 * Execute a single unary HTTP/2 RPC request.
 * Sends bodyBytes and collects all response frames into a single Buffer.
 *
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.path - RPC path
 * @param {Buffer|Uint8Array} options.bodyBytes - framed Connect Protocol message
 * @param {number} [options.timeoutMs=30000]
 * @returns {Promise<Buffer>} - concatenated response body bytes (without Connect framing)
 */
export function h2RequestUnary({ accessToken, path, bodyBytes, timeoutMs = 30000 }) {
    return new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { client.close(); } catch {}
            reject(new Error(`HTTP/2 request timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const client = http2.connect(CURSOR_API_URL);
        client.on('error', (err) => {
            clearTimeout(timer);
            if (!timedOut) reject(err);
        });

        const headers = buildCursorH2Headers(accessToken, path);
        const req = client.request(headers);

        req.on('error', (err) => {
            clearTimeout(timer);
            if (!timedOut) {
                try { client.close(); } catch {}
                reject(err);
            }
        });

        // Write the framed request body
        req.write(bodyBytes);
        req.end();

        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            clearTimeout(timer);
            if (timedOut) return;
            try { client.close(); } catch {}
            resolve(Buffer.concat(chunks));
        });
    });
}

/**
 * Create an HTTP/2 streaming RPC connection.
 * Returns the client session and stream for bidirectional use.
 *
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} [options.path='/agent.v1.AgentService/Run']
 * @returns {{ client: http2.ClientHttp2Session, stream: http2.ClientHttp2Stream }}
 */
export function h2RequestStream({ accessToken, path = '/agent.v1.AgentService/Run' }) {
    const client = http2.connect(CURSOR_API_URL);
    // Swallow connection-level errors to prevent unhandled rejection;
    // stream-level errors are handled by callers.
    client.on('error', () => {});

    const headers = buildCursorH2Headers(accessToken, path);
    const stream = client.request(headers);

    return { client, stream };
}
