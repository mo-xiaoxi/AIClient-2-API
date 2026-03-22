/**
 * Unit tests for utils/logger.js
 *
 * Tests: Logger class instantiation, log level filtering, file output,
 *        request context tracking, formatMessage.
 * ESM: direct import (logger.js uses only native Node modules)
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { Logger } from '../../../src/utils/logger.js';

// We test the Logger class directly to avoid side-effects from the singleton.

let logger;

beforeEach(() => {
    logger = new Logger();
});

afterEach(() => {
    logger.close();
});

// =============================================================================
// Instantiation and defaults
// =============================================================================

describe('Logger instantiation', () => {
    test('creates instance with default config', () => {
        expect(logger.config.enabled).toBe(true);
        expect(logger.config.outputMode).toBe('all');
        expect(logger.config.logLevel).toBe('info');
    });

    test('levels map contains debug, info, warn, error', () => {
        expect(logger.levels.debug).toBeDefined();
        expect(logger.levels.info).toBeDefined();
        expect(logger.levels.warn).toBeDefined();
        expect(logger.levels.error).toBeDefined();
    });

    test('requestContext is empty Map on creation', () => {
        expect(logger.requestContext.size).toBe(0);
    });
});

// =============================================================================
// initialize()
// =============================================================================

describe('initialize()', () => {
    test('sets enabled to false when outputMode is none', () => {
        logger.initialize({ outputMode: 'none' });
        expect(logger.config.enabled).toBe(false);
    });

    test('merges config values', () => {
        logger.initialize({ logLevel: 'debug', includeTimestamp: false });
        expect(logger.config.logLevel).toBe('debug');
        expect(logger.config.includeTimestamp).toBe(false);
    });

    test('does not enable file logging when outputMode is console', () => {
        logger.initialize({ outputMode: 'console' });
        expect(logger.logStream).toBeNull();
    });
});

// =============================================================================
// shouldLog() — level filtering
// =============================================================================

describe('shouldLog()', () => {
    test('returns false when logger is disabled', () => {
        logger.config.enabled = false;
        expect(logger.shouldLog('info')).toBe(false);
    });

    test('filters out debug when level is info', () => {
        logger.config.logLevel = 'info';
        expect(logger.shouldLog('debug')).toBe(false);
        expect(logger.shouldLog('info')).toBe(true);
    });

    test('allows warn and error when level is warn', () => {
        logger.config.logLevel = 'warn';
        expect(logger.shouldLog('info')).toBe(false);
        expect(logger.shouldLog('warn')).toBe(true);
        expect(logger.shouldLog('error')).toBe(true);
    });

    test('only allows error when level is error', () => {
        logger.config.logLevel = 'error';
        expect(logger.shouldLog('warn')).toBe(false);
        expect(logger.shouldLog('error')).toBe(true);
    });

    test('allows all levels when level is debug', () => {
        logger.config.logLevel = 'debug';
        expect(logger.shouldLog('debug')).toBe(true);
        expect(logger.shouldLog('info')).toBe(true);
        expect(logger.shouldLog('error')).toBe(true);
    });
});

// =============================================================================
// formatMessage()
// =============================================================================

describe('formatMessage()', () => {
    test('includes [INFO] tag', () => {
        const msg = logger.formatMessage('info', ['hello'], null);
        expect(msg).toContain('[INFO]');
    });

    test('includes message content', () => {
        const msg = logger.formatMessage('info', ['test message'], null);
        expect(msg).toContain('test message');
    });

    test('includes requestId when provided', () => {
        const msg = logger.formatMessage('info', ['msg'], 'req-abc');
        expect(msg).toContain('req-abc');
    });

    test('includes timestamp when includeTimestamp is true', () => {
        logger.config.includeTimestamp = true;
        const msg = logger.formatMessage('info', ['msg'], null);
        // Timestamp format: YYYY-MM-DD HH:MM:SS.mmm
        expect(msg).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    test('omits timestamp when includeTimestamp is false', () => {
        logger.config.includeTimestamp = false;
        const msg = logger.formatMessage('info', ['msg'], null);
        expect(msg).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    test('serializes object arguments to JSON', () => {
        const msg = logger.formatMessage('info', [{ key: 'value' }], null);
        expect(msg).toContain('"key"');
    });
});

// =============================================================================
// Request context tracking
// =============================================================================

describe('request context', () => {
    test('setRequestContext stores context and returns requestId', () => {
        const id = logger.setRequestContext('req-1', { userId: 'u1' });
        expect(id).toBe('req-1');
        expect(logger.requestContext.has('req-1')).toBe(true);
    });

    test('getRequestContext returns stored context', () => {
        logger.setRequestContext('req-2', { userId: 'u2' });
        const ctx = logger.getRequestContext('req-2');
        expect(ctx.userId).toBe('u2');
    });

    test('clearRequestContext removes the entry', () => {
        logger.setRequestContext('req-3', {});
        logger.clearRequestContext('req-3');
        expect(logger.requestContext.has('req-3')).toBe(false);
    });

    test('getRequestContext returns empty object for unknown id', () => {
        const ctx = logger.getRequestContext('nonexistent');
        expect(ctx).toEqual({});
    });

    test('runWithContext provides requestId to getCurrentRequestId inside callback', async () => {
        let capturedId;
        await logger.runWithContext('run-req-1', () => {
            capturedId = logger.getCurrentRequestId();
        });
        expect(capturedId).toBe('run-req-1');
    });
});

// =============================================================================
// withRequest()
// =============================================================================

describe('withRequest()', () => {
    test('returns object with debug, info, warn, error methods', () => {
        const reqLogger = logger.withRequest('req-x');
        expect(typeof reqLogger.debug).toBe('function');
        expect(typeof reqLogger.info).toBe('function');
        expect(typeof reqLogger.warn).toBe('function');
        expect(typeof reqLogger.error).toBe('function');
    });
});

// =============================================================================
// Console output (spying)
// =============================================================================

describe('console output', () => {
    test('info() writes to console when outputMode is console', () => {
        logger.initialize({ outputMode: 'console', logLevel: 'info' });
        const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
        logger.info('test-output');
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('error() uses console.error', () => {
        logger.initialize({ outputMode: 'console', logLevel: 'info' });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logger.error('err-output');
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('debug() is suppressed when logLevel is info', () => {
        logger.initialize({ outputMode: 'console', logLevel: 'info' });
        const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
        logger.debug('debug-output');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
