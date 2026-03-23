/**
 * E2E: 认证行为验证
 * 验证无 key → 401，错误 key → 401，正确 key → 200，以及多种 header 格式。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import { startMockUpstreamStack } from '../../helpers/start-mock-upstream-stack.js';

describe('E2E Auth', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMockUpstreamStack();
    }, 120000);

    afterAll(async () => {
        if (stack) {
            await stack.stop();
        }
    }, 30000);

    const chatBody = JSON.stringify({
        model: 'stub-gpt',
        messages: [{ role: 'user', content: 'auth test' }],
    });

    function postChat(base, headers) {
        return fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: chatBody,
        });
    }

    test('no API key returns 401', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postChat(base, {});
        expect(res.status).toBe(401);
    });

    test('wrong API key returns 401', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postChat(base, { Authorization: 'Bearer wrong-key' });
        expect(res.status).toBe(401);
    });

    test('correct API key via Authorization Bearer returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postChat(base, {
            Authorization: `Bearer ${stack.apiKey}`,
        });
        expect(res.status).toBe(200);
    });

    test('correct API key via x-api-key header returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postChat(base, { 'x-api-key': stack.apiKey });
        expect(res.status).toBe(200);
    });

    test('correct API key via x-goog-api-key header returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postChat(base, { 'x-goog-api-key': stack.apiKey });
        expect(res.status).toBe(200);
    });

    test('partial key (trimmed) returns 401', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const partialKey = stack.apiKey.slice(0, -1);
        const res = await postChat(base, {
            Authorization: `Bearer ${partialKey}`,
        });
        expect(res.status).toBe(401);
    });

    test('401 response contains error message', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postChat(base, { Authorization: 'Bearer bad-key' });
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error).toBeDefined();
        expect(typeof json.error.message).toBe('string');
    });

    test('health endpoint does not require auth', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
    });
});
