/**
 * openai-custom / forward 链路：与 forward-mock-upstream 同栈，显式命名满足「每提供商至少 1 条集成用例」。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import { startMockUpstreamStack } from '../helpers/start-mock-upstream-stack.js';

describe('OpenAI provider path (integration)', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMockUpstreamStack();
    }, 120000);

    afterAll(async () => {
        if (stack) await stack.stop();
    }, 30000);

    test('POST /v1/chat/completions reaches stub (forward-api stack)', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'openai-provider-test' }],
            }),
        });
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.choices?.[0]?.message?.content).toBe('stub-reply');
    });
});
