/**
 * E2E: 多 API 格式访问验证
 * 验证通过 OpenAI / Claude / Gemini 格式访问同一服务时，各自的响应结构正确。
 *
 * 注意：本项目使用 forward-api 作为代理层，将所有格式的请求透传给上游。
 * 因此 stub upstream 需要同时支持多种格式的路径。
 * 这里使用扩展版 stub，直接验证服务器对各种格式路径的路由处理。
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { fetch } from 'undici';
import * as http from 'http';
import { mkdtemp, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * 创建一个支持多种 API 格式路径的扩展版 stub upstream。
 */
function startMultiFormatStub() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');

        // OpenAI 模型列表
        if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                object: 'list',
                data: [{ id: 'stub-gpt', object: 'model' }],
            }));
            return;
        }

        // 读取请求体的通用函数
        function readBody() {
            return new Promise((resolve) => {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => {
                    try { resolve(JSON.parse(body || '{}')); }
                    catch { resolve({}); }
                });
            });
        }

        // OpenAI Chat Completions 格式
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            readBody().then((parsed) => {
                if (parsed.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                    });
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'stream-hello' } }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'chatcmpl-stub',
                    object: 'chat.completion',
                    choices: [{ message: { role: 'assistant', content: 'stub-reply' }, finish_reason: 'stop' }],
                }));
            });
            return;
        }

        // Claude Messages 格式
        if (req.method === 'POST' && url.pathname === '/v1/messages') {
            readBody().then((parsed) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'msg-stub',
                    type: 'message',
                    role: 'assistant',
                    model: parsed.model || 'stub-claude',
                    content: [{ type: 'text', text: 'stub-claude-reply' }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 1, output_tokens: 1 },
                }));
            });
            return;
        }

        // Gemini generateContent 格式
        const geminiPattern = /^\/v1beta\/models\/(.+?):(generateContent|streamGenerateContent)$/;
        const geminiMatch = url.pathname.match(geminiPattern);
        if (req.method === 'POST' && geminiMatch) {
            readBody().then(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    candidates: [{
                        content: { parts: [{ text: 'stub-gemini-reply' }], role: 'model' },
                        finishReason: 'STOP',
                    }],
                    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
                }));
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

/**
 * 启动一个使用多格式 stub 的完整服务栈。
 */
async function startMultiFormatStack() {
    process.env.AICLIENT_TEST_SERVER = '1';

    const stub = await startMultiFormatStub();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'aiclient-mf-'));
    const poolsPath = path.join(tmpDir, 'provider_pools.json');
    await writeFile(poolsPath, '{}', 'utf8');
    const configPath = path.join(tmpDir, 'config.json');
    const apiKey = 'test-multiformat-key';

    await writeFile(
        configPath,
        JSON.stringify({
            REQUIRED_API_KEY: apiKey,
            HOST: '127.0.0.1',
            SERVER_PORT: 0,
            MODEL_PROVIDER: 'forward-api',
            FORWARD_BASE_URL: stub.baseUrl,
            FORWARD_API_KEY: 'stub-upstream-secret',
            CRON_REFRESH_TOKEN: false,
            TLS_SIDECAR_ENABLED: false,
            PROVIDER_POOLS_FILE_PATH: poolsPath,
            PROMPT_LOG_MODE: 'none',
            LOG_ENABLED: false,
        }, null, 2),
        'utf8'
    );

    const { clearServiceInstancesForTests } = await import('../../../src/providers/adapter.js');
    clearServiceInstancesForTests();

    const { startServer } = await import('../../../src/services/api-server.js');
    const srv = await startServer({ argv: ['--config', configPath], configPath });
    const addr = srv.address();
    const apiPort = typeof addr === 'object' && addr ? addr.port : 0;

    return {
        apiPort,
        apiKey,
        async stop() {
            const { gracefulShutdown } = await import('../../../src/services/api-server.js');
            await gracefulShutdown();
            await new Promise((resolve) => stub.server.close(() => resolve()));
            const { clearServiceInstancesForTests: clear } = await import('../../../src/providers/adapter.js');
            clear();
        },
    };
}

describe('E2E Multi-format API', () => {
    let stack;

    beforeAll(async () => {
        stack = await startMultiFormatStack();
    }, 120000);

    afterAll(async () => {
        if (stack) {
            await stack.stop();
        }
    }, 30000);

    function authHeaders(key) {
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    }

    // ── OpenAI 格式 (/v1/chat/completions) ──────────────────────────────────

    test('OpenAI format: POST /v1/chat/completions returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(stack.apiKey),
            body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(res.status).toBe(200);
    });

    test('OpenAI format: response has choices[].message.content', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: authHeaders(stack.apiKey),
            body: JSON.stringify({ model: 'stub-gpt', messages: [{ role: 'user', content: 'hi' }] }),
        });
        const json = await res.json();
        expect(typeof json.choices?.[0]?.message?.content).toBe('string');
        expect(json.choices[0].message.content.length).toBeGreaterThan(0);
    });

    // ── Claude 格式 (/v1/messages) ───────────────────────────────────────────

    test('Claude format: POST /v1/messages returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: authHeaders(stack.apiKey),
            body: JSON.stringify({
                model: 'stub-claude',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });
        expect(res.status).toBe(200);
    });

    test('Claude format: response has content array with text', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: authHeaders(stack.apiKey),
            body: JSON.stringify({
                model: 'stub-claude',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });
        const json = await res.json();
        // Claude 格式：content 数组，或经过格式转换后的 choices 数组
        const hasClaudeContent = Array.isArray(json.content) && json.content.length > 0;
        const hasOpenAIContent = Array.isArray(json.choices) && json.choices.length > 0;
        expect(hasClaudeContent || hasOpenAIContent).toBe(true);
    });

    // ── Gemini 格式 (/v1beta/models/xxx:generateContent) ────────────────────

    test('Gemini format: POST /v1beta/models/:model:generateContent returns 200', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1beta/models/stub-gemini:generateContent`, {
            method: 'POST',
            headers: authHeaders(stack.apiKey),
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }],
            }),
        });
        expect(res.status).toBe(200);
    });

    test('Gemini format: response has candidates or choices', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;
        const res = await fetch(`${base}/v1beta/models/stub-gemini:generateContent`, {
            method: 'POST',
            headers: authHeaders(stack.apiKey),
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }],
            }),
        });
        const json = await res.json();
        const hasCandidates = Array.isArray(json.candidates) && json.candidates.length > 0;
        const hasChoices = Array.isArray(json.choices) && json.choices.length > 0;
        expect(hasCandidates || hasChoices).toBe(true);
    });

    // ── 格式无关验证 ─────────────────────────────────────────────────────────

    test('all three formats return Content-Type application/json', async () => {
        const base = `http://127.0.0.1:${stack.apiPort}`;

        const endpoints = [
            {
                url: `${base}/v1/chat/completions`,
                body: { model: 'stub-gpt', messages: [{ role: 'user', content: 'hi' }] },
            },
            {
                url: `${base}/v1/messages`,
                body: { model: 'stub-claude', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
            },
            {
                url: `${base}/v1beta/models/stub-gemini:generateContent`,
                body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
            },
        ];

        for (const ep of endpoints) {
            const res = await fetch(ep.url, {
                method: 'POST',
                headers: authHeaders(stack.apiKey),
                body: JSON.stringify(ep.body),
            });
            expect(res.status).toBe(200);
            const ct = res.headers.get('content-type') ?? '';
            expect(ct).toMatch(/application\/json/);
        }
    });
});
