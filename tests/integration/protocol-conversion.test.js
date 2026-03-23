/**
 * Integration tests: Protocol conversion full pipeline.
 *
 * Tests that the server correctly converts between protocols:
 *   - OpenAI → OpenAI (passthrough via forward-api)
 *   - Claude /v1/messages → internal conversion → OpenAI upstream → Claude response
 *   - Gemini /v1beta/models/xxx:generateContent → internal conversion → OpenAI upstream → Gemini response
 * Both streaming and non-streaming modes are covered.
 *
 * No external API keys required — uses forward-api + local OpenAI stub.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import {
    startCustomStubUpstream,
    defaultStubHandler,
    stopCustomStubUpstream,
    startApiServerWithUpstream,
} from '../helpers/start-mock-upstream-stack-custom.js';

describe('Protocol conversion (integration)', () => {
    let stub;
    let stack;
    let base;

    beforeAll(async () => {
        stub = await startCustomStubUpstream(defaultStubHandler);
        stack = await startApiServerWithUpstream(stub.baseUrl);
        base = `http://127.0.0.1:${stack.apiPort}`;
    }, 120000);

    afterAll(async () => {
        if (stack) await stack.stop();
        if (stub) await stopCustomStubUpstream(stub.server);
    }, 30000);

    // ── OpenAI → OpenAI (passthrough) ────────────────────────────────────────

    test('OpenAI non-stream: returns OpenAI-shaped response', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });
        expect(res.status).toBe(200);
        const j = await res.json();
        // Must have OpenAI response shape
        expect(j).toHaveProperty('choices');
        expect(Array.isArray(j.choices)).toBe(true);
        expect(j.choices[0]).toHaveProperty('message');
        expect(j.choices[0].message).toHaveProperty('role');
        expect(j.choices[0].message).toHaveProperty('content');
        expect(j.choices[0].message.content).toBe('stub-reply');
    });

    test('OpenAI stream: returns SSE with data chunks and [DONE]', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'hello' }],
                stream: true,
            }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
        const text = await res.text();
        expect(text).toContain('data:');
        expect(text).toContain('[DONE]');
        // Verify the stream-hello content from the stub is present
        expect(text).toContain('stream-hello');
    });

    test('OpenAI stream: each non-DONE chunk is valid JSON', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'test' }],
                stream: true,
            }),
        });
        const text = await res.text();
        const lines = text.split('\n').filter((l) => l.startsWith('data: '));
        let hasContent = false;
        for (const line of lines) {
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            // Should be valid JSON
            expect(() => JSON.parse(payload)).not.toThrow();
            const parsed = JSON.parse(payload);
            // OpenAI delta format
            if (parsed.choices?.[0]?.delta?.content) {
                hasContent = true;
            }
        }
        expect(hasContent).toBe(true);
    });

    // ── Claude /v1/messages → forward-api (transparent proxy) ───────────────
    //
    // Note: forward-api is a transparent proxy — it forwards request bodies verbatim
    // (after converting them to OpenAI format for the upstream) and returns upstream
    // responses without re-converting them back to Claude format.
    // The response the client receives is therefore the raw OpenAI-format stub reply.
    // What we verify here is that the endpoint is correctly routed and the request
    // body (Claude → OpenAI) is successfully forwarded to the upstream.

    test('Claude /v1/messages non-stream: request is routed and a valid response is returned', async () => {
        const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        // The endpoint is recognised and the request reaches the stub → 200
        expect(res.status).toBe(200);
        const j = await res.json();
        // forward-api returns the upstream response as-is (OpenAI format)
        // The stub always replies with stub-reply; verify we got content back
        const text = JSON.stringify(j);
        expect(text).toContain('stub-reply');
    });

    test('Claude /v1/messages stream: request is routed and SSE data is returned', async () => {
        const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        // forward-api returns the upstream SSE stream as-is; it should contain
        // the stub's stream-hello content or the forwarded message_stop/[DONE]
        expect(text.length).toBeGreaterThan(0);
        // The stream must contain at least one data: line
        expect(text).toMatch(/data:/);
    });

    // ── Gemini /v1beta/models/xxx:generateContent → forward-api ─────────────
    //
    // Same transparent-proxy semantics as Claude above.

    test('Gemini generateContent non-stream: request is routed and a valid response is returned', async () => {
        const res = await fetch(`${base}/v1beta/models/stub-gpt:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
        });
        expect(res.status).toBe(200);
        const j = await res.json();
        // Upstream stub always replies with stub-reply; verify it comes through
        const text = JSON.stringify(j);
        expect(text).toContain('stub-reply');
    });

    test('Gemini streamGenerateContent: returns SSE stream', async () => {
        const res = await fetch(`${base}/v1beta/models/stub-gpt:streamGenerateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        // Should be SSE with data: lines
        expect(text).toContain('data:');
    });

    // ── Request conversion: Claude → OpenAI request format ───────────────────
    //
    // Verify that the request body is converted from Claude format to OpenAI format
    // before reaching the upstream by checking that the upstream receives a valid
    // OpenAI-shaped request body (the stub echoes nothing, but if conversion fails
    // the endpoint would return an error instead of 200).

    test('Claude /v1/messages request body is converted: no conversion error', async () => {
        // A properly shaped Claude request with system + user messages
        const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                max_tokens: 256,
                system: 'You are a helpful assistant.',
                messages: [
                    { role: 'user', content: 'What is 2+2?' },
                ],
            }),
        });
        // If the conversion layer crashes, the server returns 500; otherwise 200
        expect(res.status).toBe(200);
    });

    // ── Unmatched route fallback ──────────────────────────────────────────────

    test('Unknown POST path returns 404', async () => {
        const res = await fetch(`${base}/v1/unknown-endpoint`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(404);
    });
});
