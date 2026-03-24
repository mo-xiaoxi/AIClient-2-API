/**
 * Claude /v1/messages 集成（forward-api + stub）。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import {
    startCustomStubUpstream,
    defaultStubHandler,
    stopCustomStubUpstream,
    startApiServerWithUpstream,
} from '../helpers/start-mock-upstream-stack-custom.js';

describe('Claude provider path (integration)', () => {
    let stub;
    let stack;

    beforeAll(async () => {
        stub = await startCustomStubUpstream(defaultStubHandler);
        stack = await startApiServerWithUpstream(stub.baseUrl);
    }, 120000);

    afterAll(async () => {
        if (stack) await stack.stop();
        if (stub) await stopCustomStubUpstream(stub.server);
    }, 30000);

    test('POST /v1/messages returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'stub-gpt',
                max_tokens: 50,
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        expect(res.status).toBe(200);
    });
});
