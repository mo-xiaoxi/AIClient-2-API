/**
 * Unit tests for src/providers/copilot/copilot-core.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetValidCopilotJwt = jest.fn();
const mockInvalidateJwt = jest.fn();
const mockIsExpiryDateNear = jest.fn(() => false);

await jest.unstable_mockModule('../../../src/providers/copilot/copilot-token-store.js', () => ({
    CopilotTokenStore: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        getValidCopilotJwt: mockGetValidCopilotJwt,
        invalidateJwt: mockInvalidateJwt,
        isExpiryDateNear: mockIsExpiryDateNear,
    })),
}));

let CopilotApiService;

beforeAll(async () => {
    ({ CopilotApiService } = await import('../../../src/providers/copilot/copilot-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidCopilotJwt.mockResolvedValue({ token: 'copilot-jwt', apiEndpoint: 'https://api.githubcopilot.com' });
    mockIsExpiryDateNear.mockReturnValue(false);
});

describe('CopilotApiService', () => {
    test('constructor sets credFilePath from config', () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        expect(svc.credFilePath).toBe('/tmp/copilot.json');
        expect(svc.isInitialized).toBe(false);
    });

    test('initialize throws when credFilePath is not configured', async () => {
        const svc = new CopilotApiService({});
        await expect(svc.initialize()).rejects.toThrow('COPILOT_OAUTH_CREDS_FILE_PATH');
    });

    test('initialize sets isInitialized to true', async () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
    });

    test('initialize is idempotent', async () => {
        const { CopilotTokenStore } = await import('../../../src/providers/copilot/copilot-token-store.js');
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        await svc.initialize();
        expect(CopilotTokenStore).toHaveBeenCalledTimes(1);
    });

    test('listModels uses cache on second call within TTL', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                data: [{ id: 'gpt-4o' }, { id: 'claude-sonnet-4' }],
            }),
        });
        global.fetch = mockFetch;

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const r1 = await svc.listModels();
        const r2 = await svc.listModels();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(r1).toEqual(r2);
        delete global.fetch;
    });

    test('listModels falls back to static list on fetch failure', async () => {
        const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
        global.fetch = mockFetch;

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const result = await svc.listModels();

        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
        delete global.fetch;
    });

    test('refreshToken skips invalidation when token is fresh', async () => {
        mockIsExpiryDateNear.mockReturnValue(false);
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockInvalidateJwt).not.toHaveBeenCalled();
    });

    test('refreshToken invalidates JWT when token is near expiry', async () => {
        mockIsExpiryDateNear.mockReturnValue(true);
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockInvalidateJwt).toHaveBeenCalledTimes(1);
    });

    test('forceRefreshToken invalidates and pre-warms JWT', async () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        await svc.forceRefreshToken();
        expect(mockInvalidateJwt).toHaveBeenCalledTimes(1);
        expect(mockGetValidCopilotJwt).toHaveBeenCalled();
    });

    test('generateContent returns parsed JSON on success', async () => {
        const responsePayload = { id: 'cmpl-1', choices: [{ message: { content: 'Hello' } }] };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(JSON.stringify(responsePayload)),
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const result = await svc.generateContent('gpt-4o', { messages: [{ role: 'user', content: 'Hi' }] });
        expect(result.id).toBe('cmpl-1');
        delete global.fetch;
    });

    test('generateContent throws on non-ok response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: () => Promise.resolve('Unauthorized'),
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        await expect(svc.generateContent('gpt-4o', { messages: [] })).rejects.toThrow('Copilot API error (401)');
        expect(mockInvalidateJwt).toHaveBeenCalled();
        delete global.fetch;
    });

    test('generateContent throws on network error', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('connection refused'));

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        await expect(svc.generateContent('gpt-4o', { messages: [] })).rejects.toThrow('Network error');
        delete global.fetch;
    });

    test('generateContentStream yields parsed SSE chunks', async () => {
        const chunk = { choices: [{ delta: { content: 'hi' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

        const encoder = new TextEncoder();
        const encoded = encoder.encode(sseData);
        let offset = 0;

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: {
                getReader: () => ({
                    read: jest.fn()
                        .mockResolvedValueOnce({ done: false, value: encoded })
                        .mockResolvedValueOnce({ done: true }),
                    cancel: jest.fn().mockResolvedValue(undefined),
                }),
            },
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();

        const chunks = [];
        for await (const c of svc.generateContentStream('gpt-4o', { messages: [{ role: 'user', content: 'Hi' }] })) {
            chunks.push(c);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        delete global.fetch;
    });

    test('generateContentStream throws on non-ok response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: () => Promise.resolve('Forbidden'),
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const gen = svc.generateContentStream('gpt-4o', { messages: [] });
        await expect(gen.next()).rejects.toThrow('Copilot API error (403)');
        delete global.fetch;
    });

    test('_buildHeaders includes required headers', async () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const h = svc._buildHeaders('jwt-token', { messages: [{ role: 'user', content: 'Hi' }] });
        expect(h['Authorization']).toBe('Bearer jwt-token');
        expect(h['Content-Type']).toBe('application/json');
        expect(h['X-Initiator']).toBe('user');
    });

    test('_buildHeaders sets Copilot-Vision-Request for image content', async () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const body = {
            messages: [{
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: 'http://img.example.com/a.jpg' } }]
            }]
        };
        const h = svc._buildHeaders('jwt-token', body);
        expect(h['Copilot-Vision-Request']).toBe('true');
    });

    test('_detectInitiator returns agent for assistant role', async () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const result = svc._detectInitiator({ messages: [{ role: 'assistant', content: 'hi' }] });
        expect(result).toBe('agent');
    });

    test('_detectInitiator returns user for user role', async () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const result = svc._detectInitiator({ messages: [{ role: 'user', content: 'hi' }] });
        expect(result).toBe('user');
    });

    test('_hasVisionContent returns true when image_url present', async () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const body = {
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://img.example.com/a.jpg' } }] }]
        };
        expect(svc._hasVisionContent(body)).toBe(true);
    });

    test('_hasVisionContent returns false when no image content', async () => {
        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const body = { messages: [{ role: 'user', content: 'just text' }] };
        expect(svc._hasVisionContent(body)).toBe(false);
    });

    test('generateContent throws on invalid JSON response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('not valid json {'),
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        await expect(svc.generateContent('gpt-4o', { messages: [] })).rejects.toThrow('Failed to parse response JSON');
        delete global.fetch;
    });

    test('generateContentStream skips malformed SSE chunks', async () => {
        const chunk = { choices: [{ delta: { content: 'ok' } }] };
        const sseData = `data: not-json\n\ndata: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
        const encoder = new TextEncoder();
        const encoded = encoder.encode(sseData);

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: {
                getReader: () => ({
                    read: jest.fn()
                        .mockResolvedValueOnce({ done: false, value: encoded })
                        .mockResolvedValueOnce({ done: true }),
                    cancel: jest.fn().mockResolvedValue(undefined),
                }),
            },
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const chunks = [];
        for await (const c of svc.generateContentStream('gpt-4o', { messages: [] })) {
            chunks.push(c);
        }
        expect(chunks.length).toBe(1);
        delete global.fetch;
    });

    test('listModels fetches and parses API response (success path)', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
                data: [
                    { id: 'gpt-4o', name: 'GPT-4o' },
                    { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
                ],
            })),
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        expect(result.data.some(m => m.id === 'gpt-4o')).toBe(true);
        delete global.fetch;
    });

    test('listModels handles non-ok API response by using fallback', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Server Error'),
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        delete global.fetch;
    });

    test('listModels handles invalid JSON in API response by using fallback', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('invalid-json'),
        });

        const svc = new CopilotApiService({ COPILOT_OAUTH_CREDS_FILE_PATH: '/tmp/copilot.json' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        delete global.fetch;
    });
});
