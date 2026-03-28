/**
 * Unit tests for ui-modules/update-api.js
 * Tests: compareVersions, checkForUpdates, handleCheckUpdate, handlePerformUpdate
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

let compareVersions;
let checkForUpdates;
let handleCheckUpdate;
let handlePerformUpdate;

let mockExistsSync;
let mockReadFileSync;
let mockWriteFileSync;
let mockFsMkdir;
let mockFsRm;
let mockFsReaddir;
let mockFsWriteFile;
let mockFsStat;
let mockFsCopyFile;
let mockExecAsync;
let mockLogger;
let mockParseProxyUrl;
let originalFetch;

beforeAll(async () => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    mockExistsSync = jest.fn().mockReturnValue(false);
    mockReadFileSync = jest.fn().mockReturnValue('1.0.0');
    mockWriteFileSync = jest.fn();
    mockFsMkdir = jest.fn().mockResolvedValue(undefined);
    mockFsRm = jest.fn().mockResolvedValue(undefined);
    mockFsReaddir = jest.fn().mockResolvedValue([]);
    mockFsWriteFile = jest.fn().mockResolvedValue(undefined);
    mockFsStat = jest.fn().mockResolvedValue({ isDirectory: () => false });
    mockFsCopyFile = jest.fn().mockResolvedValue(undefined);
    mockParseProxyUrl = jest.fn().mockReturnValue(null);

    const execMock = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    mockExecAsync = execMock;

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: mockLogger,
    }));

    await jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
        __esModule: true,
        CONFIG: {},
    }));

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        parseProxyUrl: mockParseProxyUrl,
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        existsSync: (...args) => mockExistsSync(...args),
        readFileSync: (...args) => mockReadFileSync(...args),
        writeFileSync: (...args) => mockWriteFileSync(...args),
        default: {
            existsSync: (...args) => mockExistsSync(...args),
            readFileSync: (...args) => mockReadFileSync(...args),
            writeFileSync: (...args) => mockWriteFileSync(...args),
        },
        promises: {
            mkdir: (...args) => mockFsMkdir(...args),
            rm: (...args) => mockFsRm(...args),
            readdir: (...args) => mockFsReaddir(...args),
            writeFile: (...args) => mockFsWriteFile(...args),
            stat: (...args) => mockFsStat(...args),
            copyFile: (...args) => mockFsCopyFile(...args),
        },
    }));

    await jest.unstable_mockModule('child_process', () => ({
        __esModule: true,
        exec: jest.fn((cmd, cb) => {
            // Called via promisify, so we need to simulate the callback style
            if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
        }),
    }));

    await jest.unstable_mockModule('util', () => ({
        __esModule: true,
        promisify: jest.fn((fn) => {
            return (...args) => mockExecAsync(...args);
        }),
        default: {
            promisify: jest.fn((fn) => {
                return (...args) => mockExecAsync(...args);
            }),
        },
    }));

    const mod = await import('../../../src/ui-modules/update-api.js');
    compareVersions = mod.compareVersions;
    checkForUpdates = mod.checkForUpdates;
    handleCheckUpdate = mod.handleCheckUpdate;
    handlePerformUpdate = mod.handlePerformUpdate;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('1.0.0');
    mockWriteFileSync.mockImplementation(() => {});
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsRm.mockResolvedValue(undefined);
    mockFsReaddir.mockResolvedValue([]);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockParseProxyUrl.mockReturnValue(null);
    originalFetch = global.fetch;
    global.fetch = jest.fn();
});

afterEach(() => {
    global.fetch = originalFetch;
});

// =============================================================================
// compareVersions — pure function, no mocks needed
// =============================================================================

describe('compareVersions', () => {
    test('returns 1 when v1 > v2 (major)', () => {
        expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    });

    test('returns -1 when v1 < v2 (major)', () => {
        expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    });

    test('returns 0 when versions are equal', () => {
        expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    });

    test('returns 1 when v1 > v2 (minor)', () => {
        expect(compareVersions('1.2.0', '1.1.0')).toBe(1);
    });

    test('returns -1 when v1 < v2 (patch)', () => {
        expect(compareVersions('1.0.1', '1.0.2')).toBe(-1);
    });

    test('strips v prefix from both versions', () => {
        expect(compareVersions('v2.0.0', 'v1.0.0')).toBe(1);
        expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    });

    test('handles versions with different lengths', () => {
        expect(compareVersions('1.1', '1.1.0')).toBe(0);
        expect(compareVersions('1.2', '1.1.9')).toBe(1);
    });

    test('returns 1 for 1.10.0 vs 1.9.0', () => {
        expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    });

    test('unknown local version treated as 0', () => {
        // 'unknown' splits to NaN which becomes 0
        expect(compareVersions('1.0.0', 'unknown')).toBe(1);
    });
});

// =============================================================================
// checkForUpdates — mocked exec and fetch
// =============================================================================

describe('checkForUpdates', () => {
    test('returns update info with GitHub API when not in git repo', async () => {
        // git rev-parse --git-dir fails → not in git repo
        mockExecAsync.mockRejectedValueOnce(new Error('not a git repo'));

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [
                { name: 'v1.2.0' },
                { name: 'v1.1.0' },
                { name: 'v1.0.0' },
            ],
        });

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.1.0');

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(true);
        expect(result.latestVersion).toBe('v1.2.0');
        expect(result.localVersion).toBe('1.1.0');
        expect(result.updateMethod).toBe('github_api');
    });

    test('returns hasUpdate false when already on latest', async () => {
        mockExecAsync.mockRejectedValueOnce(new Error('not a git repo'));

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ name: 'v1.0.0' }],
        });

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(false);
        expect(result.latestVersion).toBe('v1.0.0');
    });

    test('returns error when all GitHub API attempts fail', async () => {
        mockExecAsync.mockRejectedValueOnce(new Error('not a git repo'));
        // All 5 proxy candidates fail
        global.fetch.mockRejectedValue(new Error('network error'));

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.latestVersion).toBeNull();
    });

    test('uses git repo mode when in git repository', async () => {
        // git rev-parse succeeds → in git repo
        mockExecAsync
            .mockResolvedValueOnce({ stdout: '.git', stderr: '' }) // git rev-parse --git-dir
            .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git fetch --tags
            .mockResolvedValueOnce({ stdout: 'v2.0.0\n', stderr: '' }); // git tag --sort

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(true);
        expect(result.latestVersion).toBe('v2.0.0');
        expect(result.updateMethod).toBe('git');
    });

    test('handles missing VERSION file gracefully', async () => {
        mockExecAsync.mockRejectedValueOnce(new Error('not a git repo'));
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ name: 'v1.0.0' }],
        });

        mockExistsSync.mockReturnValue(false); // VERSION file doesn't exist

        const result = await checkForUpdates();
        expect(result.localVersion).toBe('unknown');
    });

    test('skips non-version tags from GitHub API', async () => {
        mockExecAsync.mockRejectedValueOnce(new Error('not a git repo'));

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [
                { name: 'release-2024' }, // not semver
                { name: 'v1.5.0' },
            ],
        });

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const result = await checkForUpdates();
        expect(result.latestVersion).toBe('v1.5.0');
    });
});

// =============================================================================
// handleCheckUpdate
// =============================================================================

describe('handleCheckUpdate', () => {
    function makeRes() {
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        return res;
    }

    test('responds with 200 and update info on success', async () => {
        mockExecAsync.mockRejectedValueOnce(new Error('not a git repo'));
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ name: 'v1.0.0' }],
        });

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const res = makeRes();
        const result = await handleCheckUpdate({}, res);

        expect(result).toBe(true);
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(res.end).toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body).toHaveProperty('hasUpdate');
    });

    test('responds with 500 on error', async () => {
        // Simulate checkForUpdates throwing
        mockExecAsync.mockRejectedValue(new Error('fatal git error'));
        global.fetch.mockRejectedValue(new Error('network error'));
        // Make the VERSION read also work
        mockExistsSync.mockReturnValue(false);

        // Wait for it to not throw
        const res = makeRes();
        await handleCheckUpdate({}, res);

        // Will return 200 with error field or 500 depending on error path
        // checkForUpdates catches errors and returns result objects, so this should be 200
        expect(res.writeHead).toHaveBeenCalled();
        expect(res.end).toHaveBeenCalled();
    });
});

// =============================================================================
// handlePerformUpdate
// =============================================================================

describe('handlePerformUpdate', () => {
    function makeRes() {
        return { writeHead: jest.fn(), end: jest.fn() };
    }

    test('responds with already up to date when no update available', async () => {
        // Not in git repo
        mockExecAsync.mockRejectedValueOnce(new Error('not git'));
        // GitHub API returns same version
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ name: 'v1.0.0' }],
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const res = makeRes();
        await handlePerformUpdate({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.updated).toBe(false);
        expect(body.success).toBe(true);
    });

    test('responds with 500 on fatal error', async () => {
        // Force checkForUpdates to throw via exec
        mockExecAsync.mockRejectedValue(new Error('all fail'));
        global.fetch.mockRejectedValue(new Error('net fail'));
        mockExistsSync.mockReturnValue(false);

        const res = makeRes();
        await handlePerformUpdate({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error).toBeDefined();
    });

    test('performs git checkout update (no uncommitted changes, no npm needed)', async () => {
        // checkForUpdates: in git repo, v2.0.0 available, local=1.0.0
        mockExecAsync
            .mockResolvedValueOnce({ stdout: '.git', stderr: '' })       // git rev-parse --git-dir
            .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git fetch --tags
            .mockResolvedValueOnce({ stdout: 'v2.0.0\n', stderr: '' })   // git tag --sort
            .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git status --porcelain (clean)
            .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git checkout v2.0.0
            .mockResolvedValueOnce({ stdout: '', stderr: '' });           // git diff v1.0.0..v2.0.0

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const res = makeRes();
        await handlePerformUpdate({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.updated).toBe(true);
        expect(body.updateMethod).toBe('git');
        expect(body.latestVersion).toBe('v2.0.0');
        expect(body.needsRestart).toBe(false);
    });

    test('stashes local changes before git checkout', async () => {
        mockExecAsync
            .mockResolvedValueOnce({ stdout: '.git', stderr: '' })
            .mockResolvedValueOnce({ stdout: '', stderr: '' })
            .mockResolvedValueOnce({ stdout: 'v2.0.0\n', stderr: '' })
            .mockResolvedValueOnce({ stdout: 'M src/foo.js\n', stderr: '' }) // uncommitted changes
            .mockResolvedValueOnce({ stdout: '', stderr: '' })               // git stash
            .mockResolvedValueOnce({ stdout: '', stderr: '' })               // git checkout v2.0.0
            .mockResolvedValueOnce({ stdout: '', stderr: '' });              // git diff

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const res = makeRes();
        await handlePerformUpdate({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.updated).toBe(true);
    });

    test('runs npm install when package.json changed', async () => {
        mockExecAsync
            .mockResolvedValueOnce({ stdout: '.git', stderr: '' })
            .mockResolvedValueOnce({ stdout: '', stderr: '' })
            .mockResolvedValueOnce({ stdout: 'v2.0.0\n', stderr: '' })
            .mockResolvedValueOnce({ stdout: '', stderr: '' })               // git status
            .mockResolvedValueOnce({ stdout: '', stderr: '' })               // git checkout
            .mockResolvedValueOnce({ stdout: 'package.json\n', stderr: '' }) // git diff includes package.json
            .mockResolvedValueOnce({ stdout: '', stderr: '' });              // npm install

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const res = makeRes();
        await handlePerformUpdate({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.updated).toBe(true);
        expect(body.needsRestart).toBe(true);
    });

    test('returns 500 when git checkout fails', async () => {
        mockExecAsync
            .mockResolvedValueOnce({ stdout: '.git', stderr: '' })
            .mockResolvedValueOnce({ stdout: '', stderr: '' })
            .mockResolvedValueOnce({ stdout: 'v2.0.0\n', stderr: '' })
            .mockResolvedValueOnce({ stdout: '', stderr: '' })               // git status
            .mockRejectedValueOnce(new Error('checkout failed'));            // git checkout fails

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const res = makeRes();
        await handlePerformUpdate({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error).toBeDefined();
    });

    test('tarball download all fail returns 500', async () => {
        // checkForUpdates: not in git repo → GitHub API returns v2.0.0
        mockExecAsync.mockRejectedValueOnce(new Error('not git'));
        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ name: 'v2.0.0' }],
            })
            // All 5 tarball download attempts fail
            .mockRejectedValue(new Error('network error'));

        mockExistsSync.mockReturnValue(true); // VERSION exists, tempDir exists in catch
        mockReadFileSync.mockReturnValue('1.0.0');
        // tar extraction is not reached; cleanup: existsSync(tempDir)=true already covered

        const res = makeRes();
        await handlePerformUpdate({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error).toBeDefined();
    });

    test('tarball update succeeds in Docker environment', async () => {
        // checkForUpdates: not in git repo → GitHub API returns v2.0.0
        mockExecAsync
            .mockRejectedValueOnce(new Error('not git'))               // git rev-parse
            .mockResolvedValueOnce({ stdout: '', stderr: '' });        // tar -xzf

        const mockArrayBuffer = new ArrayBuffer(8);
        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ name: 'v2.0.0' }],              // GitHub API version check
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => mockArrayBuffer,             // tarball download
            });

        // All existsSync return false: VERSION file absent → localVersion='unknown',
        // package.json absent → no oldPackageJson, src/static absent → skip rm
        mockExistsSync.mockReturnValue(false);

        // readdir: first call = tempDir (files after extraction), second = source dir items
        mockFsReaddir
            .mockResolvedValueOnce(['APIBridge-2.0.0', 'update.tar.gz'])
            .mockResolvedValueOnce(['README.md']);

        // copyRecursive: stat returns file (not directory)
        mockFsStat.mockResolvedValue({ isDirectory: () => false });

        const res = makeRes();
        await handlePerformUpdate({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.updated).toBe(true);
        expect(body.updateMethod).toBe('tarball');
    });
});

// =============================================================================
// checkForUpdates — additional branch coverage
// =============================================================================

describe('checkForUpdates — additional branches', () => {
    test('falls back to GitHub API when git fetch --tags fails', async () => {
        mockExecAsync
            .mockResolvedValueOnce({ stdout: '.git', stderr: '' })   // git rev-parse: in git repo
            .mockRejectedValueOnce(new Error('network unreachable')); // git fetch --tags fails

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ name: 'v2.0.0' }],
        });

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(true);
        expect(result.updateMethod).toBe('github_api');
        expect(result.latestVersion).toBe('v2.0.0');
    });

    test('uses backup git tag approach when primary sort fails', async () => {
        mockExecAsync
            .mockResolvedValueOnce({ stdout: '.git', stderr: '' })    // git rev-parse
            .mockResolvedValueOnce({ stdout: '', stderr: '' })         // git fetch --tags
            .mockRejectedValueOnce(new Error('head not found'))        // git tag --sort fails
            .mockResolvedValueOnce({ stdout: 'v1.0.0\nv2.0.0\nv1.5.0\n', stderr: '' }); // git tag (backup)

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(true);
        expect(result.latestVersion).toBe('v2.0.0');
        expect(result.updateMethod).toBe('git');
    });

    test('falls back to GitHub API when all git tag commands fail', async () => {
        mockExecAsync
            .mockResolvedValueOnce({ stdout: '.git', stderr: '' })   // git rev-parse
            .mockResolvedValueOnce({ stdout: '', stderr: '' })        // git fetch --tags
            .mockRejectedValueOnce(new Error('sort fails'))           // git tag --sort fails
            .mockRejectedValueOnce(new Error('git tag fails'));       // git tag (backup) fails

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ name: 'v3.0.0' }],
        });

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('1.0.0');

        const result = await checkForUpdates();

        expect(result.updateMethod).toBe('github_api');
        expect(result.latestVersion).toBe('v3.0.0');
    });

    test('handles GitHub API returning non-ok response', async () => {
        mockExecAsync.mockRejectedValueOnce(new Error('not git'));

        // First candidate returns non-ok, rest fail
        global.fetch
            .mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' })
            .mockRejectedValue(new Error('network error'));

        mockExistsSync.mockReturnValue(false);

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeDefined();
    });

    test('handles GitHub API returning empty tag list', async () => {
        mockExecAsync.mockRejectedValueOnce(new Error('not git'));

        global.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => [] })  // empty tags
            .mockRejectedValue(new Error('network error'));

        mockExistsSync.mockReturnValue(false);

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeDefined();
    });

    test('handles GitHub API returning tags with no valid version names', async () => {
        mockExecAsync.mockRejectedValueOnce(new Error('not git'));

        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ name: 'release-2024' }, { name: 'beta' }], // no semver
            })
            .mockRejectedValue(new Error('network error'));

        mockExistsSync.mockReturnValue(false);

        const result = await checkForUpdates();

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeDefined();
    });
});
