/**
 * Minimal OpenAI-compatible HTTP stub for integration / E2E tests.
 */
import * as http from 'http';

/**
 * @returns {Promise<{ server: import('http').Server, port: number, baseUrl: string }>}
 */
export function startStubOpenAIUpstream() {
    const server = http.createServer((req, res) => {
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

        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            let body = '';
            req.on('data', (c) => {
                body += c;
            });
            req.on('end', () => {
                let parsed = {};
                try {
                    parsed = JSON.parse(body || '{}');
                } catch {
                    /* ignore */
                }
                if (parsed.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                    });
                    res.write(
                        `data: ${JSON.stringify({
                            choices: [{ delta: { content: 'stream-hello' } }],
                        })}\n\n`
                    );
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        id: 'chatcmpl-stub',
                        object: 'chat.completion',
                        choices: [
                            {
                                message: { role: 'assistant', content: 'stub-reply' },
                                finish_reason: 'stop',
                            },
                        ],
                    })
                );
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

export function stopStubOpenAIUpstream(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}
