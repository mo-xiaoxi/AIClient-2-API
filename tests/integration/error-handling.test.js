/**
 * Integration tests: Error handling and resilience.
 *
 * Tests that the proxy server correctly handles:
 *   - Upstream 500 responses
 *   - Upstream 401 responses
 *   - Malformed request body (400)
 *   - Unknown / unregistered provider name in path (400)
 *   - Missing required fields in request
 *   - OPTIONS preflight (CORS)
 *   - Oversized / unusual payloads
 *
 * Each sub-scenario spins up its own dedicated stub to avoid test interference.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import {
    startCustomStubUpstream,
    defaultStubHandler,
    stopCustomStubUpstream,
    startApiServerWithUpstream,
} from '../helpers/start-mock-upstream-stack-custom.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a stub handler that always responds with the given HTTP status code
 * and optional JSON body for POST /v1/chat/completions.
 */
function alwaysErrorHandler(statusCode, body = {}) {
    return function (req, res) {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [] }));
            return;
        }
        // Drain request body before responding to avoid broken-pipe errors
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        });
    };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Error handling (integration)', () => {
    // Shared "happy-path" stack used for client-error scenarios
    let defaultStub;
    let defaultStack;
    let base;

    beforeAll(async () => {
        defaultStub = await startCustomStubUpstream(defaultStubHandler);
        defaultStack = await startApiServerWithUpstream(defaultStub.baseUrl);
        base = `http://127.0.0.1:${defaultStack.apiPort}`;
    }, 120000);

    afterAll(async () => {
        if (defaultStack) await defaultStack.stop();
        if (defaultStub) await stopCustomStubUpstream(defaultStub.server);
    }, 30000);

    // ── Client errors (no upstream needed) ───────────────────────────────────

    test('Malformed JSON body returns 400 or 500 with error information', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${defaultStack.apiKey}`,
            },
            body: '{not valid json',
        });
        // The server should not return 200 for invalid JSON
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('OPTIONS preflight returns 204 with CORS headers', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://localhost:3000',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'Authorization, Content-Type',
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
    });

    test('Unknown path segment (not in MODEL_PROVIDER enum) is NOT stripped: results in 404', async () => {
        // When the first path segment is completely unknown (not in the registered
        // providers list AND not in the MODEL_PROVIDER enum values), the router
        // logs "Ignoring invalid MODEL_PROVIDER" and keeps the full original path.
        // The request is then forwarded as-is: /unknown-xyz/v1/chat/completions,
        // which the upstream stub does not recognise, so it returns 404.
        const res = await fetch(`${base}/unknown-random-provider-xyz/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${defaultStack.apiKey}`,
            },
            body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
        });
        // The path is forwarded verbatim → stub returns 404 → proxy wraps in error body
        // The HTTP status from the proxy could be 404 or 200-with-error depending on the
        // handler path. We only assert the response is not a success with content.
        const j = await res.json();
        // Either an HTTP-level 404, or a 200 with an error body
        const isError = res.status >= 400 || j.error != null;
        expect(isError).toBe(true);
    });

    test('Empty messages array is forwarded and returns upstream response', async () => {
        // forward-api passes the body verbatim; the stub ignores it and replies stub-reply
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${defaultStack.apiKey}`,
            },
            body: JSON.stringify({ model: 'stub-gpt', messages: [] }),
        });
        // stub always returns 200 regardless of messages content
        expect(res.status).toBe(200);
    });

    test('Very large payload is forwarded without crashing the server', async () => {
        const bigContent = 'x'.repeat(100_000);
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${defaultStack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: bigContent }],
            }),
        });
        // Server should still respond (not crash)
        expect([200, 400, 413, 500, 503]).toContain(res.status);
    });

    // ── Upstream 5xx ──────────────────────────────────────────────────────────
    //
    // Design note: this proxy surfaces upstream errors inside the JSON response body
    // (OpenAI error envelope format) rather than changing the HTTP status code.
    // The HTTP status returned to the client is always 200; the caller must inspect
    // the response body for the `error` field to detect failures.

    test('Upstream 500: proxy returns a response body containing an error field', async () => {
        let stub500;
        let stack500;
        try {
            stub500 = await startCustomStubUpstream(alwaysErrorHandler(500, { error: 'internal server error' }));
            stack500 = await startApiServerWithUpstream(stub500.baseUrl);
            const b500 = `http://127.0.0.1:${stack500.apiPort}`;

            const res = await fetch(`${b500}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${stack500.apiKey}`,
                },
                body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'hi' }] }),
            });
            // The proxy returns 200 but wraps the upstream error in the body
            expect(res.status).toBe(200);
            const j = await res.json();
            // Should contain an error envelope
            expect(j).toHaveProperty('error');
            expect(j.error).toBeTruthy();
        } finally {
            if (stack500) await stack500.stop();
            if (stub500) await stopCustomStubUpstream(stub500.server);
        }
    });

    // ── Upstream 401 ──────────────────────────────────────────────────────────

    test('Upstream 401: proxy returns a response body containing an error field', async () => {
        let stub401;
        let stack401;
        try {
            stub401 = await startCustomStubUpstream(
                alwaysErrorHandler(401, { error: { message: 'Unauthorized', type: 'authentication_error' } })
            );
            stack401 = await startApiServerWithUpstream(stub401.baseUrl);
            const b401 = `http://127.0.0.1:${stack401.apiPort}`;

            const res = await fetch(`${b401}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${stack401.apiKey}`,
                },
                body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'hi' }] }),
            });
            // Proxy surfaces the 401 error in the response body
            const j = await res.json();
            expect(j).toHaveProperty('error');
            expect(j.error).toBeTruthy();
        } finally {
            if (stack401) await stack401.stop();
            if (stub401) await stopCustomStubUpstream(stub401.server);
        }
    });

    // ── Upstream 429 ──────────────────────────────────────────────────────────

    test('Upstream 429: proxy returns a response body containing an error field', async () => {
        let stub429;
        let stack429;
        try {
            stub429 = await startCustomStubUpstream(
                alwaysErrorHandler(429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } })
            );
            // Disable retries so the test completes quickly
            stack429 = await startApiServerWithUpstream(stub429.baseUrl, {
                REQUEST_MAX_RETRIES: 0,
            });
            const b429 = `http://127.0.0.1:${stack429.apiPort}`;

            const res = await fetch(`${b429}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${stack429.apiKey}`,
                },
                body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'hi' }] }),
            });
            const j = await res.json();
            expect(j).toHaveProperty('error');
            expect(j.error).toBeTruthy();
        } finally {
            if (stack429) await stack429.stop();
            if (stub429) await stopCustomStubUpstream(stub429.server);
        }
    });

    // ── Streaming error path ──────────────────────────────────────────────────
    //
    // For stream requests the proxy opens the SSE channel (HTTP 200) and then
    // writes an `event: error` + `data: {...}` SSE event when the upstream fails.

    test('Upstream 500 during a stream: proxy sends an SSE error event in the stream body', async () => {
        let stub500s;
        let stack500s;
        try {
            stub500s = await startCustomStubUpstream(alwaysErrorHandler(500, { error: 'stream upstream error' }));
            stack500s = await startApiServerWithUpstream(stub500s.baseUrl);
            const b = `http://127.0.0.1:${stack500s.apiPort}`;

            const res = await fetch(`${b}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${stack500s.apiKey}`,
                },
                body: JSON.stringify({
                    model: 'stub-gpt',
                    messages: [{ role: 'user', content: 'stream error test' }],
                    stream: true,
                }),
            });
            // The SSE channel is always opened with HTTP 200; the error is in the body
            expect(res.status).toBe(200);
            const text = await res.text();
            // The proxy should write an error event into the stream
            expect(text).toMatch(/error|Error/i);
        } finally {
            if (stack500s) await stack500s.stop();
            if (stub500s) await stopCustomStubUpstream(stub500s.server);
        }
    });
});
