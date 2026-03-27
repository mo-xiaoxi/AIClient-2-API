/**
 * Unit tests for src/providers/codebuddy/codebuddy-core.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    MODEL_PROVIDER: { CODEBUDDY_OAUTH: 'openai-codebuddy-oauth' },
    isRetryableNetworkError: jest.fn(() => false),
}));

await jest.unstable_mockModule('../../../src/providers/provider-models.js', () => ({
    getProviderModels: jest.fn(() => ['GLM-5.0', 'GLM-4.7', 'MiniMax-M2.5']),
}));

const mockGetValidAccessToken = jest.fn();
const mockIsExpiryDateNear = jest.fn(() => false);

await jest.unstable_mockModule('../../../src/providers/codebuddy/codebuddy-token-store.js', () => ({
    CodeBuddyTokenStore: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        getValidAccessToken: mockGetValidAccessToken,
        isExpiryDateNear: mockIsExpiryDateNear,
        userId: 'test-user-id',
        domain: 'www.codebuddy.cn',
    })),
}));

let CodeBuddyApiService;

beforeAll(async () => {
    ({ CodeBuddyApiService } = await import('../../../src/providers/codebuddy/codebuddy-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue('test-access-token');
    mockIsExpiryDateNear.mockReturnValue(false);
});

describe('CodeBuddyApiService', () => {
    test('constructor stores credFilePath under _credFilePath', () => {
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        expect(svc._credFilePath).toBe('/tmp/cb.json');
        expect(svc.isInitialized).toBe(false);
    });

    test('initialize throws when credFilePath is not configured', async () => {
        const svc = new CodeBuddyApiService({ uuid: 'u1' });
        await expect(svc.initialize()).rejects.toThrow('CODEBUDDY_OAUTH_CREDS_FILE_PATH');
    });

    test('initialize sets isInitialized to true', async () => {
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        expect(svc.isInitialized).toBe(true);
    });

    test('initialize is idempotent', async () => {
        const { CodeBuddyTokenStore } = await import('../../../src/providers/codebuddy/codebuddy-token-store.js');
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        await svc.initialize();
        expect(CodeBuddyTokenStore).toHaveBeenCalledTimes(1);
    });

    test('listModels returns static model list', async () => {
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        const result = await svc.listModels();
        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0]).toHaveProperty('id');
        expect(result.data[0]).toHaveProperty('owned_by', 'codebuddy');
    });

    test('refreshToken calls getValidAccessToken when token is near expiry', async () => {
        mockIsExpiryDateNear.mockReturnValue(true);
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockGetValidAccessToken).toHaveBeenCalledTimes(1);
    });

    test('refreshToken skips refresh when token is fresh', async () => {
        mockIsExpiryDateNear.mockReturnValue(false);
        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        await svc.refreshToken();
        expect(mockGetValidAccessToken).not.toHaveBeenCalled();
    });

    test('generateContent throws on API error', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: () => Promise.resolve('Forbidden'),
        });
        global.fetch = mockFetch;

        const svc = new CodeBuddyApiService({ CODEBUDDY_OAUTH_CREDS_FILE_PATH: '/tmp/cb.json', uuid: 'u1' });
        await svc.initialize();
        await expect(
            svc.generateContent('GLM-5.0', { messages: [{ role: 'user', content: 'hi' }] })
        ).rejects.toThrow();
        delete global.fetch;
    });
});
