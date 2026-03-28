/**
 * Unit tests for utils/logger.js — file logging paths
 *
 * Tests: initializeFileLogging, checkAndRotateLogFile, cleanupOldLogs,
 *        clearTodayLog, log() file output, _ensureContextCleanup timer,
 *        close() with active stream.
 *
 * ESM: jest.unstable_mockModule + dynamic import (fs must be mocked before Logger import)
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// fs mock
// ---------------------------------------------------------------------------
const mockLogStream = {
    write: jest.fn(() => true),
    end: jest.fn(),
    destroyed: false,
    writable: true,
    on: jest.fn(),
};

const mockExistsSync = jest.fn(() => false);
const mockMkdirSync = jest.fn();
const mockCreateWriteStream = jest.fn(() => mockLogStream);
const mockStatSync = jest.fn(() => ({ size: 100, mtime: { getTime: () => Date.now() } }));
const mockReaddirSync = jest.fn(() => []);
const mockUnlinkSync = jest.fn();
const mockRenameSync = jest.fn();
const mockWriteFileSync = jest.fn();

jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: mockExistsSync,
        mkdirSync: mockMkdirSync,
        createWriteStream: mockCreateWriteStream,
        statSync: mockStatSync,
        readdirSync: mockReaddirSync,
        unlinkSync: mockUnlinkSync,
        renameSync: mockRenameSync,
        writeFileSync: mockWriteFileSync,
    };
});

let Logger;

beforeAll(async () => {
    const mod = await import('../../../src/utils/logger.js');
    Logger = mod.Logger;
});

beforeEach(() => {
    jest.clearAllMocks();
    // Reset stream state
    mockLogStream.write.mockReturnValue(true);
    mockLogStream.destroyed = false;
    mockLogStream.writable = true;
    mockCreateWriteStream.mockReturnValue(mockLogStream);
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ size: 100, mtime: { getTime: () => Date.now() } });
    mockReaddirSync.mockReturnValue([]);
});

// =============================================================================
// initializeFileLogging via initialize()
// =============================================================================

describe('initializeFileLogging()', () => {
    test('creates log directory when it does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        const logger = new Logger();
        logger.initialize({ outputMode: 'file' });
        expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
        logger.close();
    });

    test('does not create log directory when it already exists', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.initialize({ outputMode: 'file' });
        expect(mockMkdirSync).not.toHaveBeenCalled();
        logger.close();
    });

    test('creates a write stream for the log file', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.initialize({ outputMode: 'file' });
        expect(mockCreateWriteStream).toHaveBeenCalled();
        expect(logger.logStream).toBe(mockLogStream);
        logger.close();
    });

    test('registers error handler on log stream', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.initialize({ outputMode: 'file' });
        expect(mockLogStream.on).toHaveBeenCalledWith('error', expect.any(Function));
        logger.close();
    });

    test('handles mkdirSync throwing without crashing', () => {
        mockExistsSync.mockReturnValue(false);
        mockMkdirSync.mockImplementation(() => { throw new Error('Permission denied'); });
        const logger = new Logger();
        expect(() => logger.initialize({ outputMode: 'file' })).not.toThrow();
        logger.close();
    });

    test('also triggers file logging for outputMode all', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.initialize({ outputMode: 'all' });
        expect(mockCreateWriteStream).toHaveBeenCalled();
        logger.close();
    });
});

// =============================================================================
// log() file output path
// =============================================================================

describe('log() file output', () => {
    test('writes formatted message to logStream when outputMode is file', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.initialize({ outputMode: 'file', logLevel: 'info' });
        // currentLogFile must be set for checkAndRotateLogFile to proceed
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 100 }); // small file, no rotation

        logger.info('file-log-test');

        expect(mockLogStream.write).toHaveBeenCalledWith(expect.stringContaining('file-log-test'));
        logger.close();
    });

    test('catches write error and logs to console', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.initialize({ outputMode: 'file', logLevel: 'info' });
        mockLogStream.write.mockImplementation(() => { throw new Error('write error'); });
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => logger.info('trigger-write-error')).not.toThrow();
        errSpy.mockRestore();
        logger.close();
    });

    test('skips file write when logStream is destroyed', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.initialize({ outputMode: 'file', logLevel: 'info' });
        mockLogStream.destroyed = true;
        mockLogStream.write.mockClear();

        logger.info('should-be-skipped');
        expect(mockLogStream.write).not.toHaveBeenCalled();
        logger.close();
    });
});

// =============================================================================
// checkAndRotateLogFile
// =============================================================================

describe('checkAndRotateLogFile()', () => {
    test('does nothing when currentLogFile is null', () => {
        const logger = new Logger();
        logger.currentLogFile = null;
        logger.checkAndRotateLogFile();
        expect(mockStatSync).not.toHaveBeenCalled();
        logger.close();
    });

    test('does nothing when log file does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        const logger = new Logger();
        logger.currentLogFile = 'logs/app-2024-01-01.log';
        logger.checkAndRotateLogFile();
        expect(mockStatSync).not.toHaveBeenCalled();
        logger.close();
    });

    test('does not rotate when file size is within limit', () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 100 });
        const logger = new Logger();
        logger.currentLogFile = 'logs/app-2024-01-01.log';
        logger.logStream = mockLogStream;
        logger.checkAndRotateLogFile();
        expect(mockRenameSync).not.toHaveBeenCalled();
        logger.close();
    });

    test('rotates when file size exceeds maxFileSize', () => {
        const logger = new Logger();
        logger.currentLogFile = 'logs/app-2024-01-01.log';
        logger.logStream = { ...mockLogStream, destroyed: false };

        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 11 * 1024 * 1024 }); // 11MB > 10MB limit
        mockReaddirSync.mockReturnValue([]);

        logger.checkAndRotateLogFile();
        expect(mockRenameSync).toHaveBeenCalled();
        expect(mockCreateWriteStream).toHaveBeenCalled();
        logger.close();
    });

    test('handles statSync throwing without crashing', () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockImplementation(() => { throw new Error('stat error'); });
        const logger = new Logger();
        logger.currentLogFile = 'logs/app-2024-01-01.log';
        expect(() => logger.checkAndRotateLogFile()).not.toThrow();
        logger.close();
    });
});

// =============================================================================
// cleanupOldLogs
// =============================================================================

describe('cleanupOldLogs()', () => {
    test('does nothing when logDir does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        const logger = new Logger();
        logger.cleanupOldLogs();
        expect(mockReaddirSync).not.toHaveBeenCalled();
        logger.close();
    });

    test('does nothing when file count is within maxFiles limit', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(['app-2024-01-01.log', 'app-2024-01-02.log']);
        mockStatSync.mockReturnValue({ mtime: { getTime: () => Date.now() } });
        const logger = new Logger();
        logger.cleanupOldLogs();
        expect(mockUnlinkSync).not.toHaveBeenCalled();
        logger.close();
    });

    test('deletes oldest files when count exceeds maxFiles', () => {
        mockExistsSync.mockReturnValue(true);
        const files = Array.from({ length: 12 }, (_, i) => `app-2024-01-${String(i + 1).padStart(2, '0')}.log`);
        mockReaddirSync.mockReturnValue(files);
        let timeOffset = 0;
        mockStatSync.mockImplementation(() => ({ mtime: { getTime: () => timeOffset++ } }));

        const logger = new Logger();
        logger.cleanupOldLogs();
        // Should delete 2 oldest files (count 12 - maxFiles 10 = 2)
        expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
        logger.close();
    });

    test('handles unlinkSync throwing without crashing', () => {
        mockExistsSync.mockReturnValue(true);
        const files = Array.from({ length: 12 }, (_, i) => `app-2024-01-${String(i + 1).padStart(2, '0')}.log`);
        mockReaddirSync.mockReturnValue(files);
        let t = 0;
        mockStatSync.mockImplementation(() => ({ mtime: { getTime: () => t++ } }));
        mockUnlinkSync.mockImplementation(() => { throw new Error('permission denied'); });

        const logger = new Logger();
        expect(() => logger.cleanupOldLogs()).not.toThrow();
        logger.close();
    });

    test('handles readdirSync throwing without crashing', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockImplementation(() => { throw new Error('dir read error'); });
        const logger = new Logger();
        expect(() => logger.cleanupOldLogs()).not.toThrow();
        logger.close();
    });
});

// =============================================================================
// clearTodayLog
// =============================================================================

describe('clearTodayLog()', () => {
    test('returns false when currentLogFile is null', () => {
        const logger = new Logger();
        logger.currentLogFile = null;
        const result = logger.clearTodayLog();
        expect(result).toBe(false);
        logger.close();
    });

    test('returns false when log file does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        const logger = new Logger();
        logger.currentLogFile = 'logs/app-today.log';
        const result = logger.clearTodayLog();
        expect(result).toBe(false);
        logger.close();
    });

    test('truncates file and returns true on success', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.currentLogFile = 'logs/app-today.log';
        logger.logStream = { ...mockLogStream, destroyed: false };

        const result = logger.clearTodayLog();
        expect(result).toBe(true);
        expect(mockWriteFileSync).toHaveBeenCalledWith('logs/app-today.log', '');
        expect(mockCreateWriteStream).toHaveBeenCalled();
        logger.close();
    });

    test('returns false and logs error when writeFileSync throws', () => {
        mockExistsSync.mockReturnValue(true);
        mockWriteFileSync.mockImplementation(() => { throw new Error('disk full'); });
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const logger = new Logger();
        logger.currentLogFile = 'logs/app-today.log';
        logger.logStream = { ...mockLogStream, destroyed: false };

        const result = logger.clearTodayLog();
        expect(result).toBe(false);
        errSpy.mockRestore();
        logger.close();
    });
});

// =============================================================================
// close()
// =============================================================================

describe('close()', () => {
    test('ends logStream on close', () => {
        mockExistsSync.mockReturnValue(true);
        const logger = new Logger();
        logger.initialize({ outputMode: 'file' });
        logger.close();
        expect(mockLogStream.end).toHaveBeenCalled();
    });

    test('clears cleanup timer on close', () => {
        const logger = new Logger();
        // Trigger the cleanup timer by setting a context
        logger.setRequestContext('req-close', {});
        expect(logger._contextCleanupTimer).not.toBeNull();
        logger.close();
        expect(logger._contextCleanupTimer).toBeNull();
    });

    test('close() is safe when logStream is null', () => {
        const logger = new Logger();
        logger.logStream = null;
        expect(() => logger.close()).not.toThrow();
    });
});
