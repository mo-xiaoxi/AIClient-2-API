/**
 * Gemini 路径集成（forward-api + defaultStubHandler）。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import {
    startCustomStubUpstream,
    defaultStubHandler,
    stopCustomStubUpstream,
    startApiServerWithUpstream,
} from '../helpers/start-mock-upstream-stack-custom.js';

describe('Gemini provider path (integration)', () => {
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

    test('POST /v1beta/models/...:generateContent returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1beta/models/stub-gpt:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            }),
        });
        expect(res.status).toBe(200);
    });
});
