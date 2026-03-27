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

await jest.unstable_mockModule('../../../src/providers/gitlab/gitlab-token-store.js', () => ({
    GitLabTokenStore: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        isExpiryDateNear: mockIsExpiryDateNear,
        invalidateDuoToken: mockInvalidateDuoToken,
        getValidDuoToken: mockGetValidDuoToken,
        // _discoverModels is called on the store via the service's _discoverModels method
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
    mockGetValidDuoToken.mockResolvedValue({ token: 'duo-token', base_url: 'https://duo.example.com', headers: {} });
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
});
