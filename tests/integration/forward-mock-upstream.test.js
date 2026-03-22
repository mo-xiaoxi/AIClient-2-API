/**
 * Full-stack integration: api-server + forward-api + local OpenAI stub (no external keys).
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import { startMockUpstreamStack } from '../helpers/start-mock-upstream-stack.js';

describe('Forward mock upstream (integration)', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMockUpstreamStack();
    }, 120000);

    afterAll(async () => {
        if (stack) {
            await stack.stop();
        }
    }, 30000);

    test('GET /health returns healthy', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.status).toBe('healthy');
        expect(j.provider).toBe('forward-api');
    });

    test('POST /v1/chat/completions non-stream reaches stub', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
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

    test('POST /v1/chat/completions streaming returns SSE', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('stream-hello');
        expect(text).toContain('[DONE]');
    });

    test('GET /v1/models proxies stub list', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/models`, {
            headers: { Authorization: `Bearer ${stack.apiKey}` },
        });
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(Array.isArray(j.data)).toBe(true);
        expect(j.data.some((m) => m.id === 'stub-gpt')).toBe(true);
    });
});
