/**
 * E2E: 模型列表端点验证
 * 验证 GET /v1/models 和 GET /v1beta/models 的响应结构。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import { startMockUpstreamStack } from '../../helpers/start-mock-upstream-stack.js';

describe('E2E Models', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMockUpstreamStack();
    }, 120000);

    afterAll(async () => {
        if (stack) {
            await stack.stop();
        }
    }, 30000);

    function getModels(base, path) {
        return fetch(`${base}${path}`, {
            headers: { Authorization: `Bearer ${stack.apiKey}` },
        });
    }

    // ── /v1/models (OpenAI 格式) ─────────────────────────────────────────────

    test('GET /v1/models returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await getModels(base, '/v1/models');
        expect(res.status).toBe(200);
    });

    test('GET /v1/models returns JSON with object=list', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await getModels(base, '/v1/models');
        const json = await res.json();
        expect(json.object).toBe('list');
    });

    test('GET /v1/models data array is non-empty', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await getModels(base, '/v1/models');
        const json = await res.json();
        expect(Array.isArray(json.data)).toBe(true);
        expect(json.data.length).toBeGreaterThan(0);
    });

    test('GET /v1/models each entry has id field', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await getModels(base, '/v1/models');
        const json = await res.json();
        for (const model of json.data) {
            expect(typeof model.id).toBe('string');
            expect(model.id.length).toBeGreaterThan(0);
        }
    });

    test('GET /v1/models without auth returns 401', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/models`);
        expect(res.status).toBe(401);
    });

    // ── /v1beta/models (Gemini 格式) ─────────────────────────────────────────

    test('GET /v1beta/models returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await getModels(base, '/v1beta/models');
        expect(res.status).toBe(200);
    });

    test('GET /v1beta/models returns non-empty model list', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await getModels(base, '/v1beta/models');
        const json = await res.json();
        // Gemini 格式可能用 models 字段或兼容 OpenAI 的 data 字段
        const models = json.models ?? json.data;
        expect(Array.isArray(models)).toBe(true);
        expect(models.length).toBeGreaterThan(0);
    });

    test('GET /v1beta/models without auth returns 401', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1beta/models`);
        expect(res.status).toBe(401);
    });
});
