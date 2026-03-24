/**
 * Grok 经 forward-api 走 OpenAI 兼容上游时的集成烟测（与 stub OpenAI 相同）。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import { startMockUpstreamStack } from '../helpers/start-mock-upstream-stack.js';

describe('Grok-compatible forward path (integration)', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMockUpstreamStack();
    }, 120000);

    afterAll(async () => {
        if (stack) await stack.stop();
    }, 30000);

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
                messages: [{ role: 'user', content: 'stream' }],
                stream: true,
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('data:');
    });
});
