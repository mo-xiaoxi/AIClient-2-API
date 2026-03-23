/**
 * Enhanced mock upstream stack that accepts a custom request handler,
 * allowing tests to inject different upstream behaviors (errors, timeouts, etc.).
 */
import { mkdtemp, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

/**
 * Start a stub upstream server with a custom handler.
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @returns {Promise<{ server: http.Server, port: number, baseUrl: string }>}
 */
export function startCustomStubUpstream(handler) {
    const server = http.createServer(handler);
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
 * Default OpenAI-compatible stub handler (identical to stub-openai-upstream.js).
 *
 * Also handles /v1/messages (Claude) and /v1beta/models/...:generateContent (Gemini)
 * by responding in OpenAI format — the real protocol conversion happens inside the
 * api-server before the request reaches this stub.
 */
export function defaultStubHandler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                object: 'list',
                data: [{ id: 'stub-gpt', object: 'model' }],
            })
        );
        return;
    }

    // Matches:
    //   POST /v1/chat/completions   (OpenAI)
    //   POST /v1/messages           (Claude — forward-api preserves original path)
    //   POST /v1beta/models/*       (Gemini — forward-api preserves original path)
    const isPostToContentEndpoint =
        req.method === 'POST' &&
        (url.pathname === '/v1/chat/completions' ||
            url.pathname === '/v1/messages' ||
            url.pathname.startsWith('/v1beta/models/'));

    if (isPostToContentEndpoint) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let parsed = {};
            try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }

            // Detect streaming by either the 'stream' flag (OpenAI/Claude) or
            // the streamGenerateContent action in the URL (Gemini).
            const isStream =
                parsed.stream === true ||
                url.pathname.includes(':streamGenerateContent');

            if (isStream) {
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

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
}

export function stopCustomStubUpstream(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Start the full API server stack pointing at a custom stub upstream.
 * @param {string} stubBaseUrl  - URL of the already-running stub server
 * @param {object} [extraConfig] - Extra config fields to merge into config.json
 * @returns {Promise<{ apiPort: number, apiKey: string, stop: () => Promise<void> }>}
 */
export async function startApiServerWithUpstream(stubBaseUrl, extraConfig = {}) {
    process.env.AICLIENT_TEST_SERVER = '1';

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'aiclient-int-custom-'));
    const poolsPath = path.join(tmpDir, 'provider_pools.json');
    await writeFile(poolsPath, '{}', 'utf8');
    const configPath = path.join(tmpDir, 'config.json');
    const apiKey = 'test-integration-key';

    const baseConfig = {
        REQUIRED_API_KEY: apiKey,
        HOST: '127.0.0.1',
        SERVER_PORT: 0,
        MODEL_PROVIDER: 'forward-api',
        FORWARD_BASE_URL: stubBaseUrl,
        FORWARD_API_KEY: 'stub-upstream-secret',
        CRON_REFRESH_TOKEN: false,
        TLS_SIDECAR_ENABLED: false,
        PROVIDER_POOLS_FILE_PATH: poolsPath,
        PROMPT_LOG_MODE: 'none',
        LOG_ENABLED: false,
        // Disable retry delays to keep tests fast
        REQUEST_MAX_RETRIES: 0,
        REQUEST_BASE_DELAY: 0,
    };

    await writeFile(configPath, JSON.stringify({ ...baseConfig, ...extraConfig }, null, 2), 'utf8');

    const { clearServiceInstancesForTests } = await import('../../src/providers/adapter.js');
    clearServiceInstancesForTests();

    const { startServer } = await import('../../src/services/api-server.js');
    const srv = await startServer({ argv: ['--config', configPath], configPath });
    const addr = srv.address();
    const apiPort = typeof addr === 'object' && addr ? addr.port : 0;

    return {
        apiPort,
        apiKey,
        async stop() {
            const { gracefulShutdown } = await import('../../src/services/api-server.js');
            await gracefulShutdown();
            const { clearServiceInstancesForTests: clear } = await import('../../src/providers/adapter.js');
            clear();
        },
    };
}
