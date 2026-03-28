/**
 * Unit tests for src/providers/gemini/antigravity-core.js
 * Focus: AntigravityApiService construction, URL fallback, token expiry check.
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const mockOAuthCtor = jest.fn();

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn((opts) => opts),
    getProxyConfigForProvider: jest.fn(() => null),
    getGoogleAuthProxyConfig: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['gemini-3-flash', 'claude-thinking']),
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    formatExpiryTime: jest.fn(),
    isRetryableNetworkError: jest.fn(() => false),
    formatExpiryLog: jest.fn(() => ({ message: '', isNearExpiry: false })),
    MODEL_PROVIDER: { ANTIGRAVITY: 'gemini-antigravity' },
}));

await jest.unstable_mockModule('google-auth-library', () => ({
    OAuth2Client: mockOAuthCtor,
}));

await jest.unstable_mockModule('../../../src/auth/oauth-handlers.js', () => ({
    handleGeminiAntigravityOAuth: jest.fn(),
}));

await jest.unstable_mockModule('open', () => ({
    default: jest.fn().mockResolvedValue(null),
}));

await jest.unstable_mockModule('fs', () => ({
    promises: {
        readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        writeFile: jest.fn(),
        mkdir: jest.fn(),
    },
}));

let AntigravityApiService;

beforeAll(async () => {
    mockOAuthCtor.mockImplementation(() => {
        const inst = {
            credentials: {},
            setCredentials(creds) {
                Object.assign(inst.credentials, creds);
            },
            request: jest.fn().mockResolvedValue({ data: { models: {} } }),
            refreshAccessToken: jest.fn().mockResolvedValue({
                credentials: { access_token: 'new-at', refresh_token: 'rt' },
            }),
        };
        return inst;
    });
    ({ AntigravityApiService } = await import('../../../src/providers/gemini/antigravity-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    mockOAuthCtor.mockImplementation(() => {
        const inst = {
            credentials: {},
            setCredentials(creds) {
                Object.assign(inst.credentials, creds);
            },
            request: jest.fn().mockResolvedValue({ data: { models: {} } }),
            refreshAccessToken: jest.fn().mockResolvedValue({
                credentials: { access_token: 'new-at', refresh_token: 'rt' },
            }),
        };
        return inst;
    });
});

function makeConfig(overrides = {}) {
    return {
        HOST: '127.0.0.1',
        uuid: 'test-uuid',
        PROJECT_ID: 'proj-fixed',
        ...overrides,
    };
}

describe('AntigravityApiService', () => {
    test('constructs OAuth2Client and sets base URL fallback order', () => {
        const svc = new AntigravityApiService(makeConfig());
        expect(mockOAuthCtor).toHaveBeenCalled();
        expect(Array.isArray(svc.baseURLs)).toBe(true);
        expect(svc.baseURLs.length).toBeGreaterThan(0);
    });

    test('getBaseURLFallbackOrder uses only custom ANTIGRAVITY_BASE_URL (trailing slash stripped)', () => {
        const svc = new AntigravityApiService(
            makeConfig({ ANTIGRAVITY_BASE_URL: 'https://custom.example.com/path/' }),
        );
        expect(svc.getBaseURLFallbackOrder({ ANTIGRAVITY_BASE_URL: 'https://custom.example.com/path/' })).toEqual([
            'https://custom.example.com/path',
        ]);
    });

    test('getBaseURLFallbackOrder returns default chain when no custom URL', () => {
        const svc = new AntigravityApiService(makeConfig());
        const order = svc.getBaseURLFallbackOrder({});
        expect(order.every((u) => u.startsWith('https://'))).toBe(true);
        expect(order.length).toBe(3);
    });

    test('isTokenExpiringSoon returns false when expiry_date missing', () => {
        const svc = new AntigravityApiService(makeConfig());
        expect(svc.isTokenExpiringSoon()).toBe(false);
    });

    test('isTokenExpiringSoon returns true when expiry within refresh skew window', () => {
        const svc = new AntigravityApiService(makeConfig());
        // REFRESH_SKEW is 3000s — treat token as expiring if expiry <= now + skew
        svc.authClient.credentials.expiry_date = Date.now() + 60 * 1000;
        expect(svc.isTokenExpiringSoon()).toBe(true);
    });

    test('isTokenExpiringSoon returns false when expiry far in future', () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.authClient.credentials.expiry_date = Date.now() + 365 * 24 * 60 * 60 * 1000;
        expect(svc.isTokenExpiringSoon()).toBe(false);
    });

    test('_applySidecar delegates to configureTLSSidecar', async () => {
        const { configureTLSSidecar } = await import('../../../src/utils/proxy-utils.js');
        const svc = new AntigravityApiService(makeConfig());
        const opts = { url: 'https://x' };
        svc._applySidecar(opts);
        expect(configureTLSSidecar).toHaveBeenCalled();
    });
});

// =============================================================================
// fetchAvailableModels
// =============================================================================

describe('fetchAvailableModels()', () => {
    test('sets availableModels from API response', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.authClient.request.mockResolvedValueOnce({
            data: {
                models: {
                    'gemini-3-flash': {},
                    'claude-thinking': {},
                    'unknown-model': {},
                }
            }
        });
        await svc.fetchAvailableModels();
        // claude- prefixed are converted to gemini-claude- prefix
        expect(svc.availableModels).toContain('gemini-claude-thinking');
    });

    test('falls back to ANTIGRAVITY_MODELS when all endpoints fail', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.authClient.request.mockRejectedValue(new Error('network error'));
        const initialModels = [...svc.availableModels];
        await svc.fetchAvailableModels();
        // Should fall back to default ANTIGRAVITY_MODELS
        expect(Array.isArray(svc.availableModels)).toBe(true);
    });

    test('skips endpoint when response has no models field', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.authClient.request.mockResolvedValue({ data: {} });
        await svc.fetchAvailableModels();
        // Should fall back to default models
        expect(Array.isArray(svc.availableModels)).toBe(true);
    });
});

// =============================================================================
// listModels
// =============================================================================

describe('listModels()', () => {
    test('returns formatted models list when already initialized', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-flash', 'gemini-3-pro-thinking'];

        const result = await svc.listModels();
        expect(result.models).toHaveLength(2);
        expect(result.models[0].name).toBe('models/gemini-3-flash');
        expect(result.models[0].ownedBy).toBe('antigravity');
        expect(result.models[0].type).toBe('antigravity');
    });

    test('adds thinking metadata for thinking models', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-pro-thinking'];

        const result = await svc.listModels();
        expect(result.models[0].thinking).toBeDefined();
        expect(result.models[0].thinking.min).toBe(1024);
        expect(result.models[0].thinking.max).toBe(100000);
    });

    test('no thinking metadata for non-thinking models', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-flash'];

        const result = await svc.listModels();
        expect(result.models[0].thinking).toBeUndefined();
    });
});

// =============================================================================
// callApi
// =============================================================================

describe('callApi()', () => {
    test('returns response data on success', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.authClient.request.mockResolvedValueOnce({ data: { result: 'ok' } });

        const result = await svc.callApi('generateContent', { prompt: 'hello' });
        expect(result).toEqual({ result: 'ok' });
    });

    test('throws when all base URLs exhausted', async () => {
        const svc = new AntigravityApiService(makeConfig());
        // Start with baseURLIndex beyond length
        await expect(svc.callApi('generateContent', {}, false, 0, 999))
            .rejects.toThrow('All Antigravity base URLs failed');
    });

    test('marks credential unhealthy and rethrows on 401', async () => {
        const { getProviderPoolManager } = await import('../../../src/services/service-manager.js');
        const mockPool = { markProviderNeedRefresh: jest.fn() };
        getProviderPoolManager.mockReturnValue(mockPool);

        const svc = new AntigravityApiService(makeConfig({ uuid: 'test-uuid' }));
        const authError = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
        svc.authClient.request.mockRejectedValueOnce(authError);

        await expect(svc.callApi('generateContent', {}, false)).rejects.toThrow('Unauthorized');
        expect(mockPool.markProviderNeedRefresh).toHaveBeenCalled();
    });

    test('tries next URL on 429 when more URLs available', async () => {
        const svc = new AntigravityApiService(makeConfig());
        // Ensure multiple base URLs
        svc.baseURLs = ['https://url1.example.com', 'https://url2.example.com'];

        const rateLimitError = Object.assign(new Error('Rate Limited'), { response: { status: 429 } });
        svc.authClient.request
            .mockRejectedValueOnce(rateLimitError)
            .mockResolvedValueOnce({ data: { result: 'ok' } });

        const result = await svc.callApi('generateContent', {});
        expect(result).toEqual({ result: 'ok' });
        expect(svc.authClient.request).toHaveBeenCalledTimes(2);
    });

    test('retries on 500 server error', async () => {
        const svc = new AntigravityApiService(makeConfig({ REQUEST_MAX_RETRIES: 1, REQUEST_BASE_DELAY: 1 }));
        const serverError = Object.assign(new Error('Server Error'), { response: { status: 500 } });
        svc.authClient.request
            .mockRejectedValueOnce(serverError)
            .mockResolvedValueOnce({ data: { result: 'recovered' } });

        const result = await svc.callApi('generateContent', {});
        expect(result).toEqual({ result: 'recovered' });
    });
});

// =============================================================================
// generateContent
// =============================================================================

describe('generateContent()', () => {
    function makeRequestBody(overrides = {}) {
        return {
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
            ...overrides,
        };
    }

    test('calls callApi and returns gemini response for known model', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-flash'];
        svc.projectId = 'test-project';

        svc.authClient.request.mockResolvedValueOnce({
            data: {
                response: {
                    candidates: [{ content: { parts: [{ text: 'response text' }] } }],
                }
            }
        });

        const result = await svc.generateContent('gemini-3-flash', makeRequestBody());
        expect(result).toBeDefined();
    });

    test('falls back to gemini-3-flash for unknown model', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-flash'];
        svc.projectId = 'test-project';

        svc.authClient.request.mockResolvedValueOnce({
            data: {
                response: {
                    candidates: [{ content: { parts: [{ text: 'fallback response' }] } }],
                }
            }
        });

        await svc.generateContent('unknown-model-xyz', makeRequestBody());
        // Should not throw, and should use fallback model
        expect(svc.authClient.request).toHaveBeenCalled();
    });

    test('strips _monitorRequestId and _requestBaseUrl from requestBody', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-flash'];
        svc.projectId = 'test-project';

        svc.authClient.request.mockResolvedValueOnce({
            data: {
                response: { candidates: [] }
            }
        });

        const reqBody = {
            ...makeRequestBody(),
            _monitorRequestId: 'monitor-123',
            _requestBaseUrl: 'https://example.com',
        };

        await svc.generateContent('gemini-3-flash', reqBody);
        expect(reqBody._monitorRequestId).toBeUndefined();
        expect(reqBody._requestBaseUrl).toBeUndefined();
    });

    test('removes gemini- prefix for gemini-claude- model names', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-claude-thinking'];
        svc.projectId = 'test-project';

        // Claude model goes through executeClaudeNonStream which uses streamApi
        // Mock streamApi to avoid complexity
        svc.streamApi = jest.fn(async function* () {
            yield { response: { candidates: [{ content: { parts: [{ text: 'claude response' }], role: 'model' }, finishReason: 'STOP' }] } };
        });

        const result = await svc.generateContent('gemini-claude-thinking', makeRequestBody());
        expect(result).toBeDefined();
    });
});

// =============================================================================
// generateContentStream
// =============================================================================

describe('generateContentStream()', () => {
    function makeRequestBody(overrides = {}) {
        return {
            contents: [{ role: 'user', parts: [{ text: 'Stream me' }] }],
            ...overrides,
        };
    }

    test('yields transformed chunks from streamApi', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-flash'];
        svc.projectId = 'test-project';

        svc.streamApi = jest.fn(async function* () {
            yield { response: { candidates: [{ content: { parts: [{ text: 'chunk1' }] } }] } };
            yield { response: { candidates: [{ content: { parts: [{ text: 'chunk2' }] } }] } };
        });

        const chunks = [];
        for await (const chunk of svc.generateContentStream('gemini-3-flash', makeRequestBody())) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(2);
    });

    test('falls back to gemini-3-flash for unknown model in stream', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-flash'];
        svc.projectId = 'test-project';

        svc.streamApi = jest.fn(async function* () {
            yield { response: { candidates: [] } };
        });

        const chunks = [];
        for await (const chunk of svc.generateContentStream('nonexistent-model', makeRequestBody())) {
            chunks.push(chunk);
        }
        expect(chunks).toHaveLength(1);
    });

    test('strips _monitorRequestId from requestBody', async () => {
        const svc = new AntigravityApiService(makeConfig());
        svc.isInitialized = true;
        svc.availableModels = ['gemini-3-flash'];
        svc.projectId = 'test-project';

        svc.streamApi = jest.fn(async function* () { });

        const reqBody = {
            ...makeRequestBody(),
            _monitorRequestId: 'mon-456',
            _requestBaseUrl: 'https://example.com',
        };

        // eslint-disable-next-line no-unused-vars
        for await (const _ of svc.generateContentStream('gemini-3-flash', reqBody)) { /* drain */ }
        expect(reqBody._monitorRequestId).toBeUndefined();
        expect(reqBody._requestBaseUrl).toBeUndefined();
    });
});
