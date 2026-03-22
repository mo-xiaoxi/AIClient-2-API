/**
 * Start local OpenAI stub + full api-server (forward-api) for stack tests.
 */
import { mkdtemp, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { startStubOpenAIUpstream, stopStubOpenAIUpstream } from './stub-openai-upstream.js';

/**
 * @returns {Promise<{ apiPort: number, apiKey: string, stop: () => Promise<void> }>}
 */
export async function startMockUpstreamStack() {
    process.env.AICLIENT_TEST_SERVER = '1';

    const stub = await startStubOpenAIUpstream();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'aiclient-int-'));
    const poolsPath = path.join(tmpDir, 'provider_pools.json');
    await writeFile(poolsPath, '{}', 'utf8');
    const configPath = path.join(tmpDir, 'config.json');
    const apiKey = 'test-integration-key';

    await writeFile(
        configPath,
        JSON.stringify(
            {
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
            },
            null,
            2
        ),
        'utf8'
    );

    const { clearServiceInstancesForTests } = await import('../../src/providers/adapter.js');
    clearServiceInstancesForTests();

    const { startServer } = await import('../../src/services/api-server.js');
    const srv = await startServer({
        argv: ['--config', configPath],
        configPath,
    });
    const addr = srv.address();
    const apiPort = typeof addr === 'object' && addr ? addr.port : 0;

    return {
        apiPort,
        apiKey,
        async stop() {
            const { gracefulShutdown } = await import('../../src/services/api-server.js');
            await gracefulShutdown();
            await stopStubOpenAIUpstream(stub.server);
            const { clearServiceInstancesForTests: clear } = await import('../../src/providers/adapter.js');
            clear();
        },
    };
}
