/**
 * API E2E：单进程启动 stub + forward-api 服务，验证关键用户路径（需 --runInBand）。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import { startMockUpstreamStack } from '../../helpers/start-mock-upstream-stack.js';

describe('E2E API (mock upstream)', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMockUpstreamStack();
    }, 120000);

    afterAll(async () => {
        if (stack) {
            await stack.stop();
        }
    }, 30000);

    test('journey: health → chat completion → list models', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;

        const health = await fetch(`${base}/health`);
        expect(health.status).toBe(200);

        const completion = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                messages: [{ role: 'user', content: 'e2e' }],
            }),
        });
        expect(completion.status).toBe(200);
        const json = await completion.json();
        expect(json.choices?.[0]?.message?.content).toBe('stub-reply');

        const models = await fetch(`${base}/v1/models`, {
            headers: { Authorization: `Bearer ${stack.apiKey}` },
        });
        expect(models.status).toBe(200);
        const list = await models.json();
        expect(list.data?.length).toBeGreaterThan(0);
    });
});
