/**
 * Integration tests: Provider routing mechanisms.
 *
 * Tests URL-path prefix routing, Model-Provider header routing,
 * default config routing, invalid provider rejection, and /v1/models routing.
 * Uses forward-api + local OpenAI stub — no external API keys required.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import {
    startCustomStubUpstream,
    defaultStubHandler,
    stopCustomStubUpstream,
    startApiServerWithUpstream,
} from '../helpers/start-mock-upstream-stack-custom.js';

describe('Provider routing (integration)', () => {
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

    // ── URL-path prefix routing ──────────────────────────────────────────────

    test('URL path prefix /forward-api/v1/chat/completions routes to forward-api', async () => {
        const res = await fetch(`${base}/forward-api/v1/chat/completions`, {
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
        // forward-api transparently proxies the stub response
        expect(j.choices?.[0]?.message?.content).toBe('stub-reply');
    });

    test('URL path prefix routing preserves the downstream API path', async () => {
        // POST /forward-api/v1/chat/completions is the same as POST /v1/chat/completions
        const withPrefix = await fetch(`${base}/forward-api/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'test' }] }),
        });
        const withoutPrefix = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'test' }] }),
        });
        expect(withPrefix.status).toBe(200);
        expect(withoutPrefix.status).toBe(200);
        const j1 = await withPrefix.json();
        const j2 = await withoutPrefix.json();
        // Both should return the same stub content
        expect(j1.choices?.[0]?.message?.content).toBe(j2.choices?.[0]?.message?.content);
    });

    // ── Model-Provider header routing ────────────────────────────────────────

    test('Model-Provider: forward-api header routes to forward-api', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
                'Model-Provider': 'forward-api',
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.choices?.[0]?.message?.content).toBe('stub-reply');
    });

    test('Invalid Model-Provider header returns 400 with descriptive error', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
                'Model-Provider': 'nonexistent-provider-xyz',
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        expect(res.status).toBe(400);
        const j = await res.json();
        expect(j.error?.message).toMatch(/nonexistent-provider-xyz/);
    });

    // ── Default MODEL_PROVIDER config routing ────────────────────────────────

    test('Default config MODEL_PROVIDER=forward-api routes chat completions', async () => {
        // No override header or path — relies purely on config default
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'default routing test' }],
            }),
        });
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.choices?.[0]?.message?.content).toBe('stub-reply');
    });

    // ── /v1/models routing ───────────────────────────────────────────────────

    test('GET /v1/models is routed to the provider and returns model list', async () => {
        const res = await fetch(`${base}/v1/models`, {
            headers: { Authorization: `Bearer ${stack.apiKey}` },
        });
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(Array.isArray(j.data)).toBe(true);
        expect(j.data.length).toBeGreaterThan(0);
        expect(j.data.some((m) => m.id === 'stub-gpt')).toBe(true);
    });

    test('GET /forward-api/v1/models routes via path prefix', async () => {
        const res = await fetch(`${base}/forward-api/v1/models`, {
            headers: { Authorization: `Bearer ${stack.apiKey}` },
        });
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(Array.isArray(j.data)).toBe(true);
    });

    // ── Authorization ────────────────────────────────────────────────────────

    test('Missing API key returns 401', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(res.status).toBe(401);
    });

    test('Wrong API key returns 401', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer wrong-key',
            },
            body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(res.status).toBe(401);
    });

    // ── Health check ─────────────────────────────────────────────────────────

    test('GET /health returns forward-api as current provider', async () => {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.status).toBe('healthy');
        expect(j.provider).toBe('forward-api');
    });
});
