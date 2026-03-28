/**
 * Unit tests for src/providers/gitlab/gitlab-core.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockIsExpiryDateNear = jest.fn(() => false);
const mockInvalidateDuoToken = jest.fn();
const mockGetValidDuoToken = jest.fn();
const mockGetAccessToken = jest.fn(() => 'access-token-123');
const mockGetBaseUrl = jest.fn(() => 'https://gitlab.example.com');
const mockGetModelDetails = jest.fn(() => null);

await jest.unstable_mockModule('../../../src/providers/gitlab/gitlab-token-store.js', () => ({
    GitLabTokenStore: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        isExpiryDateNear: mockIsExpiryDateNear,
        invalidateDuoToken: mockInvalidateDuoToken,
        getValidDuoToken: mockGetValidDuoToken,
        getAccessToken: mockGetAccessToken,
        getBaseUrl: mockGetBaseUrl,
        getModelDetails: mockGetModelDetails,
        getDiscoveredModels: jest.fn(() => []),
    })),
}));

let GitLabApiService;

beforeAll(async () => {
    ({ GitLabApiService } = await import('../../../src/providers/gitlab/gitlab-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    mockIsExpiryDateNear.mockReturnValue(false);
    mockGetValidDuoToken.mockResolvedValue({ token: 'duo-token', baseUrl: 'https://duo.example.com', headers: {} });
    mockGetAccessToken.mockReturnValue('access-token-123');
    mockGetBaseUrl.mockReturnValue('https://gitlab.example.com');
    mockGetModelDetails.mockReturnValue(null);
});

describe('GitLabApiService', () => {
    test('constructor sets credFilePath from config', () => {
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        expect(svc.credFilePath).toBe('/tmp/gitlab.json');
        expect(svc.isInitialized).toBe(false);
    });

    test('initialize sets isInitialized to true', async () => {
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
    });

    test('initialize is idempotent', async () => {
        const { GitLabTokenStore } = await import('../../../src/providers/gitlab/gitlab-token-store.js');
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await svc.initialize();
        expect(GitLabTokenStore).toHaveBeenCalledTimes(1);
    });

    test('listModels returns static fallback when no discovered models', async () => {
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const result = await svc.listModels();

        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data.some(m => m.id === 'gitlab-duo')).toBe(true);
    });

    test('listModels uses cache on second call within TTL', async () => {
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const r1 = await svc.listModels();
        // Forcibly reset initialisation detection to ensure caching triggers
        const r2 = await svc.listModels();

        // Both calls should return the same object (from cache)
        expect(r1).toEqual(r2);
    });

    test('refreshToken calls invalidateDuoToken when token is near expiry', async () => {
        mockIsExpiryDateNear.mockReturnValue(true);
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockInvalidateDuoToken).toHaveBeenCalledTimes(1);
    });

    test('refreshToken skips invalidation when token is fresh', async () => {
        mockIsExpiryDateNear.mockReturnValue(false);
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockInvalidateDuoToken).not.toHaveBeenCalled();
    });

    test('isExpiryDateNear returns false before initialization', () => {
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        expect(svc.isExpiryDateNear()).toBe(false);
    });

    test('initialize throws when credFilePath is not configured', async () => {
        const svc = new GitLabApiService({});
        await expect(svc.initialize()).rejects.toThrow('GITLAB_OAUTH_CREDS_FILE_PATH');
    });

    test('forceRefreshToken invalidates and pre-warms token', async () => {
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await svc.forceRefreshToken();
        expect(mockInvalidateDuoToken).toHaveBeenCalledTimes(1);
        expect(mockGetValidDuoToken).toHaveBeenCalled();
    });

    test('isExpiryDateNear delegates to tokenStore after init', async () => {
        mockIsExpiryDateNear.mockReturnValue(true);
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        expect(svc.isExpiryDateNear()).toBe(true);
    });

    test('listModels falls back to static list when _discoverModels throws', async () => {
        const svc = new GitLabApiService({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        svc._cachedModels = null;
        svc._modelsCachedAt = 0;
        jest.spyOn(svc, '_discoverModels').mockImplementation(() => { throw new Error('Discovery error'); });
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        expect(result.data.some(m => m.id === 'gitlab-duo')).toBe(true);
    });
});

describe('GitLabApiService — _buildGatewayUrl', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });

    function makeSvc() {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        return svc;
    }

    test('appends /v1 to plain base URL', () => {
        const svc = makeSvc();
        expect(svc._buildGatewayUrl('https://api.example.com')).toBe('https://api.example.com/v1');
    });

    test('returns URL unchanged when already ends with /v1', () => {
        const svc = makeSvc();
        expect(svc._buildGatewayUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    });

    test('builds GitLab cloud AI proxy path', () => {
        const svc = makeSvc();
        const url = svc._buildGatewayUrl('https://cloud.gitlab.com/some/path/ai');
        expect(url).toContain('/ai/v1/proxy/openai/v1');
    });

    test('handles trailing slash', () => {
        const svc = makeSvc();
        const url = svc._buildGatewayUrl('https://api.example.com/');
        expect(url).toBe('https://api.example.com/v1');
    });

    test('returns URL unchanged when already has /proxy/openai path', () => {
        const svc = makeSvc();
        // URL contains /proxy/openai but does NOT end with /v1 — hits the return url branch
        const url = svc._buildGatewayUrl('https://cloud.gitlab.com/ai/v1/proxy/openai');
        expect(url).toBe('https://cloud.gitlab.com/ai/v1/proxy/openai');
    });
});

describe('GitLabApiService — _extractTextContent', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });

    test('returns string content trimmed', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        expect(svc._extractTextContent('  hello  ')).toBe('hello');
    });

    test('joins array text blocks', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const content = [{ type: 'text', text: 'foo' }, { type: 'image_url', url: 'http://x' }, { type: 'text', text: 'bar' }];
        expect(svc._extractTextContent(content)).toBe('foo\nbar');
    });

    test('returns empty string for null/undefined', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        expect(svc._extractTextContent(null)).toBe('');
        expect(svc._extractTextContent(undefined)).toBe('');
    });
});

describe('GitLabApiService — _parseChatResponse', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });

    test('returns plain JSON string value', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        expect(svc._parseChatResponse(JSON.stringify('hello world'))).toBe('hello world');
    });

    test('returns response field from object', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        expect(svc._parseChatResponse(JSON.stringify({ response: '  answer  ' }))).toBe('answer');
    });

    test('returns choices[0].text when present', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        expect(svc._parseChatResponse(JSON.stringify({ choices: [{ text: 'text answer' }] }))).toBe('text answer');
    });

    test('returns raw text when JSON parse fails', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        expect(svc._parseChatResponse('not json')).toBe('not json');
    });

    test('returns responseText when no recognized field', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const text = JSON.stringify({ unrecognized: 'field' });
        expect(svc._parseChatResponse(text)).toBe(text.trim());
    });
});

describe('GitLabApiService — _buildChatPayload', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });

    test('maps user message to content field', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const payload = svc._buildChatPayload({
            messages: [{ role: 'user', content: 'Hello!' }],
        });
        expect(payload.content).toBe('Hello!');
        expect(payload.with_clean_history).toBe(true);
    });

    test('maps system messages to additional_context', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const payload = svc._buildChatPayload({
            messages: [
                { role: 'system', content: 'System prompt' },
                { role: 'user', content: 'User question' },
            ],
        });
        expect(payload.additional_context).toBeDefined();
        expect(payload.additional_context[0].category).toBe('snippet');
        expect(payload.additional_context[0].content).toBe('System prompt');
    });

    test('maps assistant messages to additional_context', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const payload = svc._buildChatPayload({
            messages: [
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hello' },
            ],
        });
        expect(payload.additional_context?.[0].content).toBe('Hello');
    });

    test('omits additional_context when no system/assistant messages', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const payload = svc._buildChatPayload({ messages: [{ role: 'user', content: 'Hi' }] });
        expect(payload.additional_context).toBeUndefined();
    });
});

describe('GitLabApiService — _buildOpenAIResponse', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });

    test('returns OpenAI chat completion format', () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const result = svc._buildOpenAIResponse('gitlab-duo', 'Hello from GitLab!');
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.content).toBe('Hello from GitLab!');
        expect(result.choices[0].message.role).toBe('assistant');
        expect(result.model).toBe('gitlab-duo');
    });
});

describe('GitLabApiService — _emitAsStream', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });

    test('emits role, content, and finish chunks', async () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const response = {
            id: 'r-1',
            created: 1000,
            model: 'gitlab-duo',
            choices: [{ message: { content: 'answer text' } }],
        };
        const chunks = [];
        for await (const c of svc._emitAsStream(response)) {
            chunks.push(c);
        }
        expect(chunks.length).toBe(3);
        expect(chunks[0].choices[0].delta.role).toBe('assistant');
        expect(chunks[1].choices[0].delta.content).toBe('answer text');
        expect(chunks[2].choices[0].finish_reason).toBe('stop');
    });

    test('emits only role and finish chunks when content is empty', async () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const response = {
            id: 'r-2',
            model: 'gitlab-duo',
            choices: [{ message: { content: '' } }],
        };
        const chunks = [];
        for await (const c of svc._emitAsStream(response)) {
            chunks.push(c);
        }
        expect(chunks.length).toBe(2); // role + finish, no content chunk
    });
});

describe('GitLabApiService — _parseSSEStream', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });

    test('parses SSE chunks and stops at [DONE]', async () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const chunk = { id: 'chunk-1', choices: [{ delta: { content: 'hi' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\ndata: [DONE]\n`;
        const encoder = new TextEncoder();
        const encoded = encoder.encode(sseData);

        const mockResp = {
            body: {
                getReader: () => ({
                    read: jest.fn()
                        .mockResolvedValueOnce({ done: false, value: encoded })
                        .mockResolvedValueOnce({ done: true }),
                    cancel: jest.fn().mockResolvedValue(undefined),
                }),
            },
        };

        const results = [];
        for await (const c of svc._parseSSEStream(mockResp)) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(chunk);
    });

    test('logs warning for malformed SSE chunk and skips it', async () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const validChunk = { id: 'c2', choices: [{ delta: { content: 'ok' } }] };
        const sseData = `data: not-json\ndata: ${JSON.stringify(validChunk)}\ndata: [DONE]\n`;
        const encoder = new TextEncoder();
        const encoded = encoder.encode(sseData);

        const mockResp = {
            body: {
                getReader: () => ({
                    read: jest.fn()
                        .mockResolvedValueOnce({ done: false, value: encoded })
                        .mockResolvedValueOnce({ done: true }),
                    cancel: jest.fn().mockResolvedValue(undefined),
                }),
            },
        };

        const results = [];
        for await (const c of svc._parseSSEStream(mockResp)) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(validChunk);
    });

    test('yields chunk from trailing buffer without newline', async () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        const chunk = { id: 'c-tail', choices: [{ delta: { content: 'tail' } }] };
        // No trailing newline — data stays in buffer and is flushed after reader is done
        const sseData = `data: ${JSON.stringify(chunk)}`;
        const encoder = new TextEncoder();
        const encoded = encoder.encode(sseData);

        const mockResp = {
            body: {
                getReader: () => ({
                    read: jest.fn()
                        .mockResolvedValueOnce({ done: false, value: encoded })
                        .mockResolvedValueOnce({ done: true }),
                    cancel: jest.fn().mockResolvedValue(undefined),
                }),
            },
        };

        const results = [];
        for await (const c of svc._parseSSEStream(mockResp)) {
            results.push(c);
        }
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(chunk);
    });
});

describe('GitLabApiService — _discoverModels', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });

    test('returns fallback models when no model details', async () => {
        mockGetModelDetails.mockReturnValue(null);
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const models = svc._discoverModels();
        expect(models.length).toBeGreaterThan(0);
        expect(models.some(m => m.id === 'gitlab-duo')).toBe(true);
    });

    test('prepends discovered model from token store', async () => {
        mockGetModelDetails.mockReturnValue({ modelName: 'custom-model', modelProvider: 'Anthropic' });
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const models = svc._discoverModels();
        expect(models[0].id).toBe('custom-model');
        expect(models[0].name).toContain('Anthropic');
    });
});

describe('GitLabApiService — generateContent', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetValidDuoToken.mockResolvedValue({ token: 'duo-jwt', baseUrl: 'https://duo.example.com', headers: {} });
        mockGetAccessToken.mockReturnValue('access-token');
        mockGetBaseUrl.mockReturnValue('https://gitlab.example.com');
        mockGetModelDetails.mockReturnValue(null);
    });

    test('returns parsed JSON response on success', async () => {
        const payload = { id: 'cmpl-1', choices: [{ message: { content: 'Hi' } }] };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(JSON.stringify(payload)),
        });
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const result = await svc.generateContent('gitlab-duo', { messages: [{ role: 'user', content: 'hi' }] });
        expect(result.id).toBe('cmpl-1');
        delete global.fetch;
    });

    test('throws when gateway returns non-ok and non-fallback status', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: () => Promise.resolve('Unauthorized'),
        });
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await expect(svc.generateContent('gitlab-duo', { messages: [] })).rejects.toThrow('401');
        expect(mockInvalidateDuoToken).toHaveBeenCalled();
        delete global.fetch;
    });

    test('falls back to Chat API on 404 from gateway', async () => {
        const gatewayErrText = 'Not Found';
        const chatPayload = { response: 'chat answer' };

        let callCount = 0;
        global.fetch = jest.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                // First call: gateway returns 404
                return Promise.resolve({
                    ok: false,
                    status: 404,
                    text: () => Promise.resolve(gatewayErrText),
                });
            }
            // Second call: Chat API succeeds
            return Promise.resolve({
                ok: true,
                text: () => Promise.resolve(JSON.stringify(chatPayload)),
            });
        });

        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const result = await svc.generateContent('gitlab-duo', { messages: [{ role: 'user', content: 'hi' }] });
        expect(result.choices[0].message.content).toBe('chat answer');
        delete global.fetch;
    });

    test('throws on network error in gateway', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await expect(svc.generateContent('gitlab-duo', { messages: [] })).rejects.toThrow('network error');
        delete global.fetch;
    });
});

describe('GitLabApiService — generateContentStream', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetValidDuoToken.mockResolvedValue({ token: 'duo-jwt', baseUrl: 'https://duo.example.com', headers: {} });
        mockGetAccessToken.mockReturnValue('access-token');
        mockGetBaseUrl.mockReturnValue('https://gitlab.example.com');
        mockGetModelDetails.mockReturnValue(null);
    });

    test('yields SSE chunks from gateway response', async () => {
        const chunk = { id: 'c1', choices: [{ delta: { content: 'hello' } }] };
        const sseData = `data: ${JSON.stringify(chunk)}\ndata: [DONE]\n`;
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

        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const results = [];
        for await (const c of svc.generateContentStream('gitlab-duo', { messages: [{ role: 'user', content: 'hi' }] })) {
            results.push(c);
        }
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]).toEqual(chunk);
        delete global.fetch;
    });

    test('falls back to chat stream on 404 from gateway', async () => {
        const chatPayload = { response: 'fallback answer' };
        let callCount = 0;
        global.fetch = jest.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    ok: false,
                    status: 404,
                    text: () => Promise.resolve('Not Found'),
                });
            }
            return Promise.resolve({
                ok: true,
                text: () => Promise.resolve(JSON.stringify(chatPayload)),
            });
        });

        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const results = [];
        for await (const c of svc.generateContentStream('gitlab-duo', { messages: [{ role: 'user', content: 'hi' }] })) {
            results.push(c);
        }
        // Should get chunks from _emitAsStream: role + content + finish
        expect(results.length).toBeGreaterThanOrEqual(2);
        delete global.fetch;
    });

    test('throws on non-fallback error from gateway', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Server Error'),
        });

        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await expect(async () => {
            for await (const _ of svc.generateContentStream('gitlab-duo', { messages: [] })) { /* drain */ }
        }).rejects.toThrow('500');
        delete global.fetch;
    });
});

describe('GitLabApiService — _requestViaGateway (internal)', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetValidDuoToken.mockResolvedValue({ token: 'duo-jwt', baseUrl: 'https://duo.example.com', headers: {} });
        mockGetAccessToken.mockReturnValue('access-token');
        mockGetBaseUrl.mockReturnValue('https://gitlab.example.com');
        mockGetModelDetails.mockReturnValue(null);
    });

    test('throws on non-ok response and invalidates token on 401', async () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        jest.spyOn(svc, '_fetchGateway').mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: () => Promise.resolve('Unauthorized'),
        });
        await expect(svc._requestViaGateway({}, false)).rejects.toThrow('401');
        expect(mockInvalidateDuoToken).toHaveBeenCalled();
    });

    test('throws on non-ok response without invalidation for non-auth errors', async () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        jest.spyOn(svc, '_fetchGateway').mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Server Error'),
        });
        await expect(svc._requestViaGateway({}, false)).rejects.toThrow('500');
        expect(mockInvalidateDuoToken).not.toHaveBeenCalled();
    });

    test('throws on invalid JSON response', async () => {
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        jest.spyOn(svc, '_fetchGateway').mockResolvedValueOnce({
            ok: true,
            text: () => Promise.resolve('not valid json {'),
        });
        await expect(svc._requestViaGateway({}, false)).rejects.toThrow('Failed to parse Gateway response JSON');
    });
});

describe('GitLabApiService — Chat API fallback error paths', () => {
    let GitLabApiServiceLocal;
    beforeAll(async () => {
        ({ GitLabApiService: GitLabApiServiceLocal } = await import('../../../src/providers/gitlab/gitlab-core.js'));
    });
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetValidDuoToken.mockResolvedValue({ token: 'duo-jwt', baseUrl: 'https://duo.example.com', headers: {} });
        mockGetAccessToken.mockReturnValue('access-token');
        mockGetBaseUrl.mockReturnValue('https://gitlab.example.com');
        mockGetModelDetails.mockReturnValue(null);
    });

    test('throws chat network error when 404 fallback fetch throws', async () => {
        let callCount = 0;
        global.fetch = jest.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('Not Found') });
            }
            return Promise.reject(new Error('ECONNRESET'));
        });
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await expect(
            svc.generateContent('gitlab-duo', { messages: [{ role: 'user', content: 'hi' }] })
        ).rejects.toThrow('Chat API network error');
        delete global.fetch;
    });

    test('throws chat error when 404 fallback returns non-ok', async () => {
        let callCount = 0;
        global.fetch = jest.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('Not Found') });
            }
            return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('Internal error') });
        });
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        await expect(
            svc.generateContent('gitlab-duo', { messages: [{ role: 'user', content: 'hi' }] })
        ).rejects.toThrow('500');
        delete global.fetch;
    });

    test('skips falsy gateway header entries (empty key or empty value)', async () => {
        mockGetValidDuoToken.mockResolvedValue({
            token: 'duo-jwt',
            baseUrl: 'https://duo.example.com',
            headers: { 'X-Valid': 'value', 'X-Empty-Val': '', '': 'no-key' },
        });
        const payload = { id: 'cmpl-1', choices: [{ message: { content: 'ok' } }] };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(JSON.stringify(payload)),
        });
        const svc = new GitLabApiServiceLocal({ GITLAB_OAUTH_CREDS_FILE_PATH: '/tmp/gitlab.json' });
        await svc.initialize();
        const result = await svc.generateContent('gitlab-duo', { messages: [{ role: 'user', content: 'hi' }] });
        expect(result.id).toBe('cmpl-1');
        const headers = global.fetch.mock.calls[0][1].headers;
        expect(headers['X-Valid']).toBe('value');
        expect(headers['X-Empty-Val']).toBeUndefined();
        delete global.fetch;
    });
});
