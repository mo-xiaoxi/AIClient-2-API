/**
 * E2E: 流式 SSE 响应验证
 * 验证 streaming chat completions 的 data: 格式、finish_reason 和 [DONE] 标记。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import { startMockUpstreamStack } from '../../helpers/start-mock-upstream-stack.js';

describe('E2E Streaming SSE', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMockUpstreamStack();
    }, 120000);

    afterAll(async () => {
        if (stack) {
            await stack.stop();
        }
    }, 30000);

    async function postStream(base, body) {
        return fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stack.apiKey}`,
            },
            body: JSON.stringify(body),
        });
    }

    test('streaming response returns 200 with text/event-stream content-type', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postStream(base, {
            model: 'stub-gpt',
            messages: [{ role: 'user', content: 'stream test' }],
            stream: true,
        });
        expect(res.status).toBe(200);
        const ct = res.headers.get('content-type') ?? '';
        expect(ct).toMatch(/text\/event-stream/);
    });

    test('streaming response body contains data: lines', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postStream(base, {
            model: 'stub-gpt',
            messages: [{ role: 'user', content: 'stream test' }],
            stream: true,
        });
        const text = await res.text();
        // SSE 格式：每行以 "data: " 开头
        const dataLines = text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data: '));
        expect(dataLines.length).toBeGreaterThan(0);
    });

    test('streaming response contains [DONE] terminator', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postStream(base, {
            model: 'stub-gpt',
            messages: [{ role: 'user', content: 'stream test' }],
            stream: true,
        });
        const text = await res.text();
        expect(text).toContain('data: [DONE]');
    });

    test('[DONE] is the last non-empty data line', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postStream(base, {
            model: 'stub-gpt',
            messages: [{ role: 'user', content: 'stream test' }],
            stream: true,
        });
        const text = await res.text();
        const dataLines = text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data: '));
        const lastDataLine = dataLines[dataLines.length - 1];
        expect(lastDataLine).toBe('data: [DONE]');
    });

    test('streaming chunk JSON is parseable and has choices array', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postStream(base, {
            model: 'stub-gpt',
            messages: [{ role: 'user', content: 'stream test' }],
            stream: true,
        });
        const text = await res.text();
        const dataLines = text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');

        expect(dataLines.length).toBeGreaterThan(0);

        // 每个 data 行（除 [DONE] 外）应当是合法 JSON
        for (const line of dataLines) {
            const jsonStr = line.slice('data: '.length);
            let parsed;
            expect(() => {
                parsed = JSON.parse(jsonStr);
            }).not.toThrow();
            expect(Array.isArray(parsed.choices)).toBe(true);
        }
    });

    test('streaming chunk delta contains content field', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postStream(base, {
            model: 'stub-gpt',
            messages: [{ role: 'user', content: 'stream test' }],
            stream: true,
        });
        const text = await res.text();
        const dataLines = text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');

        const firstChunk = JSON.parse(dataLines[0].slice('data: '.length));
        // stub upstream 返回 delta.content
        expect(firstChunk.choices[0].delta).toBeDefined();
        expect(typeof firstChunk.choices[0].delta.content).toBe('string');
    });

    test('non-streaming request does not return event-stream', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await postStream(base, {
            model: 'stub-gpt',
            messages: [{ role: 'user', content: 'no stream' }],
            // stream: false (omitted = non-streaming)
        });
        expect(res.status).toBe(200);
        const ct = res.headers.get('content-type') ?? '';
        expect(ct).not.toMatch(/text\/event-stream/);
        const json = await res.json();
        expect(json.choices?.[0]?.message?.content).toBeDefined();
    });
});
