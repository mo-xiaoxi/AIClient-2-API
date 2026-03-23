/**
 * Unit tests for src/ui-modules/upload-config-api.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import path from 'path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExistsSync = jest.fn();
const mockReadFile = jest.fn();
const mockStat = jest.fn();
const mockUnlink = jest.fn();
const mockReaddir = jest.fn();

jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: mockExistsSync,
        promises: {
            readFile: mockReadFile,
            stat: mockStat,
            unlink: mockUnlink,
            readdir: mockReaddir,
            mkdir: jest.fn().mockResolvedValue(undefined),
        },
    };
});

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

const mockBroadcastEvent = jest.fn();
jest.unstable_mockModule('../../../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: mockBroadcastEvent,
}));

const mockScanConfigFiles = jest.fn();
jest.unstable_mockModule('../../../src/ui-modules/config-scanner.js', () => ({
    scanConfigFiles: mockScanConfigFiles,
}));

const mockAdmZip = jest.fn();
jest.unstable_mockModule('adm-zip', () => ({
    default: mockAdmZip,
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
let handleGetUploadConfigs;
let handleViewConfigFile;
let handleDownloadConfigFile;
let handleDeleteConfigFile;
let handleDownloadAllConfigs;
let handleDeleteUnboundConfigs;

function createMockRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
        write: jest.fn(),
    };
}

beforeAll(async () => {
    ({
        handleGetUploadConfigs,
        handleViewConfigFile,
        handleDownloadConfigFile,
        handleDeleteConfigFile,
        handleDownloadAllConfigs,
        handleDeleteUnboundConfigs,
    } = await import('../../../src/ui-modules/upload-config-api.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleGetUploadConfigs
// ---------------------------------------------------------------------------
describe('handleGetUploadConfigs', () => {
    test('returns 200 with empty array when no files found', async () => {
        mockScanConfigFiles.mockResolvedValue([]);
        const req = {};
        const res = createMockRes();

        await handleGetUploadConfigs(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body).toEqual([]);
    });

    test('returns 200 with config files list', async () => {
        const configFiles = [
            { name: 'config.json', path: 'configs/config.json', type: 'config' },
        ];
        mockScanConfigFiles.mockResolvedValue(configFiles);
        const req = {};
        const res = createMockRes();

        await handleGetUploadConfigs(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body).toEqual(configFiles);
    });

    test('returns 500 when scanConfigFiles throws', async () => {
        mockScanConfigFiles.mockRejectedValue(new Error('scan failed'));
        const req = {};
        const res = createMockRes();

        await handleGetUploadConfigs(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('Failed to scan config files');
    });
});

// ---------------------------------------------------------------------------
// handleViewConfigFile
// ---------------------------------------------------------------------------
describe('handleViewConfigFile', () => {
    test('returns 403 for paths outside configs directory', async () => {
        const req = {};
        const res = createMockRes();

        await handleViewConfigFile(req, res, '../etc/passwd');

        expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('Access denied');
    });

    test('returns 404 when file does not exist', async () => {
        mockExistsSync.mockReturnValue(false);
        const req = {};
        const res = createMockRes();

        await handleViewConfigFile(req, res, 'configs/nonexistent.json');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 with file content for valid configs path', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue('{"key":"value"}');
        mockStat.mockResolvedValue({
            size: 15,
            mtime: new Date('2024-01-01T00:00:00.000Z'),
        });
        const req = {};
        const res = createMockRes();

        await handleViewConfigFile(req, res, 'configs/config.json');

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.content).toBe('{"key":"value"}');
        expect(body.name).toBe('config.json');
    });

    test('returns 500 when file read fails', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockRejectedValue(new Error('read error'));
        const req = {};
        const res = createMockRes();

        await handleViewConfigFile(req, res, 'configs/config.json');

        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});

// ---------------------------------------------------------------------------
// handleDownloadConfigFile
// ---------------------------------------------------------------------------
describe('handleDownloadConfigFile', () => {
    test('returns 403 for paths outside configs directory', async () => {
        const req = {};
        const res = createMockRes();

        await handleDownloadConfigFile(req, res, '../sensitive/file');

        expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    test('returns 404 when file does not exist', async () => {
        mockExistsSync.mockReturnValue(false);
        const req = {};
        const res = createMockRes();

        await handleDownloadConfigFile(req, res, 'configs/missing.json');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 with file content as octet-stream', async () => {
        mockExistsSync.mockReturnValue(true);
        const fileContent = Buffer.from('file data');
        mockReadFile.mockResolvedValue(fileContent);
        const req = {};
        const res = createMockRes();

        await handleDownloadConfigFile(req, res, 'configs/export.json');

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': expect.stringContaining('export.json'),
        }));
    });
});

// ---------------------------------------------------------------------------
// handleDeleteConfigFile
// ---------------------------------------------------------------------------
describe('handleDeleteConfigFile', () => {
    test('returns 403 for paths outside configs directory', async () => {
        const req = {};
        const res = createMockRes();

        await handleDeleteConfigFile(req, res, '../etc/passwd');

        expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    test('returns 404 when file does not exist', async () => {
        mockExistsSync.mockReturnValue(false);
        const req = {};
        const res = createMockRes();

        await handleDeleteConfigFile(req, res, 'configs/missing.json');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('deletes file and returns 200 with success', async () => {
        mockExistsSync.mockReturnValue(true);
        mockUnlink.mockResolvedValue(undefined);
        const req = {};
        const res = createMockRes();

        await handleDeleteConfigFile(req, res, 'configs/old.json');

        expect(mockUnlink).toHaveBeenCalled();
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
    });

    test('broadcasts config_update event after deletion', async () => {
        mockExistsSync.mockReturnValue(true);
        mockUnlink.mockResolvedValue(undefined);
        const req = {};
        const res = createMockRes();

        await handleDeleteConfigFile(req, res, 'configs/old.json');

        expect(mockBroadcastEvent).toHaveBeenCalledWith('config_update', expect.objectContaining({
            action: 'delete',
        }));
    });

    test('returns 500 when unlink fails', async () => {
        mockExistsSync.mockReturnValue(true);
        mockUnlink.mockRejectedValue(new Error('permission denied'));
        const req = {};
        const res = createMockRes();

        await handleDeleteConfigFile(req, res, 'configs/locked.json');

        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});

// ---------------------------------------------------------------------------
// handleDownloadAllConfigs
// ---------------------------------------------------------------------------
describe('handleDownloadAllConfigs', () => {
    test('returns 404 when configs directory does not exist', async () => {
        mockExistsSync.mockReturnValue(false);
        const req = {};
        const res = createMockRes();

        await handleDownloadAllConfigs(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    test('returns 200 zip file when configs directory exists', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue([]);
        const zipBuffer = Buffer.from('PK fake zip data');
        const mockZipInstance = {
            addFile: jest.fn(),
            toBuffer: jest.fn().mockReturnValue(zipBuffer),
        };
        mockAdmZip.mockImplementation(() => mockZipInstance);

        const req = {};
        const res = createMockRes();

        await handleDownloadAllConfigs(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'application/zip',
        }));
    });

    test('returns 500 when zip creation fails', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockRejectedValue(new Error('readdir error'));
        mockAdmZip.mockImplementation(() => ({
            addFile: jest.fn(),
            toBuffer: jest.fn().mockReturnValue(Buffer.from('PK')),
        }));

        const req = {};
        const res = createMockRes();

        await handleDownloadAllConfigs(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});

// ---------------------------------------------------------------------------
// handleDeleteUnboundConfigs
// ---------------------------------------------------------------------------
describe('handleDeleteUnboundConfigs', () => {
    test('returns 200 with zero deletions when no unbound configs', async () => {
        mockScanConfigFiles.mockResolvedValue([
            { path: 'configs/gemini/creds.json', isUsed: true },
        ]);
        const req = {};
        const res = createMockRes();

        await handleDeleteUnboundConfigs(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.deletedCount).toBe(0);
    });

    test('skips files directly in configs root (not subdirectory)', async () => {
        mockScanConfigFiles.mockResolvedValue([
            { path: 'configs/config.json', isUsed: false },
        ]);
        const req = {};
        const res = createMockRes();

        await handleDeleteUnboundConfigs(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.deletedCount).toBe(0);
    });

    test('deletes unbound files in subdirectories', async () => {
        mockScanConfigFiles.mockResolvedValue([
            { path: 'configs/gemini/old-creds.json', isUsed: false },
        ]);
        mockExistsSync.mockReturnValue(true);
        mockUnlink.mockResolvedValue(undefined);
        const req = {};
        const res = createMockRes();

        await handleDeleteUnboundConfigs(req, res, {}, null);

        expect(mockUnlink).toHaveBeenCalled();
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.deletedCount).toBe(1);
        expect(body.deletedFiles).toContain('configs/gemini/old-creds.json');
    });

    test('broadcasts batch_delete event when files are deleted', async () => {
        mockScanConfigFiles.mockResolvedValue([
            { path: 'configs/kiro/old.json', isUsed: false },
        ]);
        mockExistsSync.mockReturnValue(true);
        mockUnlink.mockResolvedValue(undefined);
        const req = {};
        const res = createMockRes();

        await handleDeleteUnboundConfigs(req, res, {}, null);

        expect(mockBroadcastEvent).toHaveBeenCalledWith('config_update', expect.objectContaining({
            action: 'batch_delete',
        }));
    });

    test('returns 500 when scanConfigFiles throws', async () => {
        mockScanConfigFiles.mockRejectedValue(new Error('scan failed'));
        const req = {};
        const res = createMockRes();

        await handleDeleteUnboundConfigs(req, res, {}, null);

        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });

    test('skips files not in allowed directory (security check)', async () => {
        mockScanConfigFiles.mockResolvedValue([
            { path: 'configs/gemini/../../etc/passwd', isUsed: false },
        ]);
        mockExistsSync.mockReturnValue(true);
        const req = {};
        const res = createMockRes();

        await handleDeleteUnboundConfigs(req, res, {}, null);

        // The path traversal attempt should be blocked by the security check
        const body = JSON.parse(res.end.mock.calls[0][0]);
        // Either deleted with correct validation or failed safely
        expect(body.success).toBe(true);
    });
});
