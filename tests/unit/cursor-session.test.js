/**
 * Unit tests for cursor-session.js
 *
 * Tests: deriveSessionKey, saveSession, getSession, removeSession,
 *        cleanupSession, removeAndCleanupSession, cleanupAllSessions,
 *        getActiveSessionCount, session expiry.
 *
 * NOTE: Must use jest.mock() (hoisted by babel-jest) instead of jest.unstable_mockModule()
 * because this project's import chain uses import.meta.url which fails under babel-jest.
 */

import { jest, describe, test, expect, afterEach } from '@jest/globals';

jest.mock('../../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import {
    deriveSessionKey,
    saveSession,
    getSession,
    removeSession,
    cleanupSession,
    removeAndCleanupSession,
    cleanupAllSessions,
    getActiveSessionCount,
} from '../../src/providers/cursor/cursor-session.js';

// ============================================================================
// Test helpers
// ============================================================================

function createMockSession(overrides = {}) {
    return {
        h2Client: { close: jest.fn() },
        h2Stream: { close: jest.fn() },
        heartbeatTimer: setInterval(() => {}, 999999),
        blobStore: new Map(),
        mcpTools: [],
        pendingExecs: [],
        ...overrides,
    };
}

// ============================================================================
// Tests
// ============================================================================

describe('deriveSessionKey', () => {
    test('generates a 16-char hex string', () => {
        const key = deriveSessionKey('claude-3.5-sonnet', [
            { role: 'user', content: 'Hello world' },
        ]);
        expect(key).toMatch(/^[0-9a-f]{16}$/);
    });

    test('is deterministic for same inputs', () => {
        const messages = [{ role: 'user', content: 'Test message' }];
        const k1 = deriveSessionKey('model-a', messages);
        const k2 = deriveSessionKey('model-a', messages);
        expect(k1).toBe(k2);
    });

    test('differs for different models', () => {
        const messages = [{ role: 'user', content: 'Same content' }];
        const k1 = deriveSessionKey('model-a', messages);
        const k2 = deriveSessionKey('model-b', messages);
        expect(k1).not.toBe(k2);
    });

    test('differs for different user messages', () => {
        const k1 = deriveSessionKey('model', [{ role: 'user', content: 'Message A' }]);
        const k2 = deriveSessionKey('model', [{ role: 'user', content: 'Message B' }]);
        expect(k1).not.toBe(k2);
    });

    test('uses first user message only', () => {
        const k1 = deriveSessionKey('model', [
            { role: 'user', content: 'First' },
            { role: 'assistant', content: 'Reply' },
            { role: 'user', content: 'Second' },
        ]);
        const k2 = deriveSessionKey('model', [
            { role: 'user', content: 'First' },
        ]);
        expect(k1).toBe(k2);
    });

    test('truncates user message to 200 chars', () => {
        const longMsg = 'A'.repeat(300);
        const shortMsg = 'A'.repeat(200);
        const k1 = deriveSessionKey('model', [{ role: 'user', content: longMsg }]);
        const k2 = deriveSessionKey('model', [{ role: 'user', content: shortMsg }]);
        expect(k1).toBe(k2);
    });

    test('handles missing user message', () => {
        const key = deriveSessionKey('model', [{ role: 'system', content: 'sys' }]);
        expect(key).toMatch(/^[0-9a-f]{16}$/);
    });

    test('handles array content (JSON.stringify)', () => {
        const key = deriveSessionKey('model', [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ]);
        expect(key).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('saveSession / getSession / removeSession', () => {
    afterEach(() => {
        cleanupAllSessions();
    });

    test('saves and retrieves a session', () => {
        const session = createMockSession();
        saveSession('key1', session);
        expect(getSession('key1')).toBe(session);
        expect(getActiveSessionCount()).toBe(1);
    });

    test('replaces existing session for same key', () => {
        const s1 = createMockSession();
        const s2 = createMockSession();
        saveSession('key1', s1);
        saveSession('key1', s2);
        expect(getSession('key1')).toBe(s2);
        expect(getActiveSessionCount()).toBe(1);
    });

    test('returns undefined for non-existent key', () => {
        expect(getSession('nonexistent')).toBeUndefined();
    });

    test('removeSession returns and removes session', () => {
        const session = createMockSession();
        saveSession('key1', session);
        const removed = removeSession('key1');
        expect(removed).toBe(session);
        expect(getSession('key1')).toBeUndefined();
        expect(getActiveSessionCount()).toBe(0);
    });

    test('removeSession returns undefined for non-existent key', () => {
        expect(removeSession('nope')).toBeUndefined();
    });
});

describe('cleanupSession', () => {
    test('cleans up heartbeat, stream, and client', () => {
        const session = createMockSession();
        cleanupSession(session);
        expect(session.h2Stream.close).toHaveBeenCalled();
        expect(session.h2Client.close).toHaveBeenCalled();
    });

    test('handles null session gracefully', () => {
        expect(() => cleanupSession(null)).not.toThrow();
    });

    test('handles session with null fields', () => {
        const session = {
            h2Client: null,
            h2Stream: null,
            heartbeatTimer: null,
        };
        expect(() => cleanupSession(session)).not.toThrow();
    });
});

describe('removeAndCleanupSession', () => {
    afterEach(() => {
        cleanupAllSessions();
    });

    test('removes and cleans up session by key', () => {
        const session = createMockSession();
        saveSession('key1', session);
        removeAndCleanupSession('key1');
        expect(getSession('key1')).toBeUndefined();
        expect(session.h2Stream.close).toHaveBeenCalled();
        expect(session.h2Client.close).toHaveBeenCalled();
    });

    test('does nothing for non-existent key', () => {
        expect(() => removeAndCleanupSession('nope')).not.toThrow();
    });
});

describe('cleanupAllSessions', () => {
    test('cleans up all active sessions', () => {
        const s1 = createMockSession();
        const s2 = createMockSession();
        saveSession('k1', s1);
        saveSession('k2', s2);
        expect(getActiveSessionCount()).toBe(2);

        cleanupAllSessions();
        expect(getActiveSessionCount()).toBe(0);
        expect(s1.h2Stream.close).toHaveBeenCalled();
        expect(s2.h2Stream.close).toHaveBeenCalled();
    });
});

describe('getActiveSessionCount', () => {
    afterEach(() => {
        cleanupAllSessions();
    });

    test('returns 0 when no sessions', () => {
        expect(getActiveSessionCount()).toBe(0);
    });

    test('tracks multiple sessions', () => {
        saveSession('a', createMockSession());
        saveSession('b', createMockSession());
        saveSession('c', createMockSession());
        expect(getActiveSessionCount()).toBe(3);
    });
});

describe('session expiry', () => {
    afterEach(() => {
        cleanupAllSessions();
    });

    test('session has _expiryTimer after save', () => {
        const session = createMockSession();
        saveSession('key1', session);
        expect(session._expiryTimer).toBeDefined();
    });

    test('replacing a session sets new expiry timer', () => {
        const s1 = createMockSession();
        saveSession('key1', s1);

        const s2 = createMockSession();
        saveSession('key1', s2);
        expect(s2._expiryTimer).toBeDefined();
    });
});
