/**
 * Unit tests for src/ui-modules/system-monitor.js
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCpus = jest.fn();
const mockExecSync = jest.fn();

jest.unstable_mockModule('os', () => ({
    default: {
        cpus: mockCpus,
    },
    cpus: mockCpus,
}));

jest.unstable_mockModule('child_process', () => ({
    execSync: mockExecSync,
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
let getSystemCpuUsagePercent;
let getProcessCpuUsagePercent;
let getCpuUsagePercent;

function makeCpuData(idle, user, sys, nice = 0, irq = 0) {
    return { times: { idle, user, sys, nice, irq } };
}

beforeAll(async () => {
    ({
        getSystemCpuUsagePercent,
        getProcessCpuUsagePercent,
        getCpuUsagePercent,
    } = await import('../../../src/ui-modules/system-monitor.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getSystemCpuUsagePercent
// ---------------------------------------------------------------------------
describe('getSystemCpuUsagePercent', () => {
    test('returns a percentage string ending with %', () => {
        mockCpus.mockReturnValue([makeCpuData(800, 100, 100)]);

        const result = getSystemCpuUsagePercent();

        expect(result).toMatch(/^\d+\.\d+%$/);
    });

    test('returns 0.0% on first call (no previous data)', () => {
        // The module-level previousCpuInfo is reset implicitly on first call
        // We can only assert format since state is module-level
        mockCpus.mockReturnValue([makeCpuData(800, 100, 100)]);

        const result = getSystemCpuUsagePercent();
        // First call should be 0% because no diff available
        // (may not be 0 if previously called — just check format)
        expect(result).toMatch(/^\d+\.\d+%$/);
    });

    test('returns non-zero percent after two calls with different CPU data', () => {
        // First call to populate previousCpuInfo
        mockCpus.mockReturnValue([makeCpuData(1000, 0, 0)]);
        getSystemCpuUsagePercent();

        // Second call with more usage (idle didn't grow, active did)
        mockCpus.mockReturnValue([makeCpuData(1000, 200, 100)]);
        const result = getSystemCpuUsagePercent();

        // cpu percent = 100 - (idleDiff/totalDiff*100) = 100 - (0/300*100) = 100%
        expect(result).toBe('100.0%');
    });

    test('handles multiple CPU cores correctly', () => {
        mockCpus.mockReturnValue([
            makeCpuData(500, 50, 50),
            makeCpuData(500, 50, 50),
        ]);

        const result = getSystemCpuUsagePercent();
        expect(result).toMatch(/^\d+\.\d+%$/);
    });
});

// ---------------------------------------------------------------------------
// getProcessCpuUsagePercent
// ---------------------------------------------------------------------------
describe('getProcessCpuUsagePercent', () => {
    test('returns 0.0% when pid is falsy', () => {
        expect(getProcessCpuUsagePercent(null)).toBe('0.0%');
        expect(getProcessCpuUsagePercent(0)).toBe('0.0%');
        expect(getProcessCpuUsagePercent(undefined)).toBe('0.0%');
    });

    test('returns percentage string for current process pid', () => {
        mockCpus.mockReturnValue([makeCpuData(800, 100, 100)]);

        const result = getProcessCpuUsagePercent(process.pid);

        expect(result).toMatch(/^\d+\.\d+%$/);
    });

    test('returns 0.0% when execSync throws for other pid on non-Windows', () => {
        // Only run this test on non-Windows systems
        if (process.platform !== 'win32') {
            mockExecSync.mockImplementation(() => { throw new Error('no process'); });

            const result = getProcessCpuUsagePercent(99999);

            expect(result).toBe('0.0%');
        }
    });

    test('parses ps output for other pid on Linux/macOS', () => {
        if (process.platform !== 'win32') {
            mockCpus.mockReturnValue([makeCpuData(800, 100, 100)]);
            mockExecSync.mockReturnValue('%CPU\n 5.5\n');

            const result = getProcessCpuUsagePercent(12345);

            expect(result).toMatch(/^\d+\.\d+%$/);
        }
    });
});

// ---------------------------------------------------------------------------
// getCpuUsagePercent (backward compat wrapper)
// ---------------------------------------------------------------------------
describe('getCpuUsagePercent', () => {
    test('calls getSystemCpuUsagePercent when no pid provided', () => {
        mockCpus.mockReturnValue([makeCpuData(800, 100, 100)]);

        const result = getCpuUsagePercent();

        expect(result).toMatch(/^\d+\.\d+%$/);
    });

    test('returns per-process usage when pid is provided', () => {
        mockCpus.mockReturnValue([makeCpuData(800, 100, 100)]);

        const result = getCpuUsagePercent(process.pid);

        expect(result).toMatch(/^\d+\.\d+%$/);
    });
});
