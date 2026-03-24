/**
 * E2E：上游错误与恢复路径（单账号 forward + stub）。
 * 多账号号池自动切换需真实多凭证配置，见 docs/dev/test-governance/tasks.md T14 说明。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import { startMockUpstreamStack } from '../../helpers/start-mock-upstream-stack.js';

describe('E2E upstream resilience (mock)', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMockUpstreamStack();
    }, 120000);

    afterAll(async () => {
        if (stack) await stack.stop();
    }, 30000);

    test('sequential chat completions both succeed (stable stub)', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        for (let i = 0; i < 2; i++) {
            const res = await fetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${stack.apiKey}`,
                },
                body: JSON.stringify({
                    model: 'stub-gpt',
                    messages: [{ role: 'user', content: `seq-${i}` }],
                }),
            });
            expect(res.status).toBe(200);
            const j = await res.json();
            expect(j.choices?.[0]?.message?.content).toBe('stub-reply');
        }
    });
});
