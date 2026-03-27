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
});
