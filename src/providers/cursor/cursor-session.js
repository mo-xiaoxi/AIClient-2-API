/**
 * cursor-session.js
 *
 * Manages active tool_calls sessions for Cursor API.
 * Each session holds an open HTTP/2 connection that is kept alive until
 * the client sends back tool results (role='tool' messages).
 *
 * Session key: SHA256(model + firstUserMessage[:200]) — 16 hex chars
 * Session timeout: 120 seconds of inactivity (auto-cleanup)
 */

import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';

const SESSION_TIMEOUT_MS = 120_000; // 120 seconds

/**
 * @typedef {Object} CursorSession
 * @property {import('node:http2').ClientHttp2Session} h2Client
 * @property {import('node:http2').ClientHttp2Stream} h2Stream
 * @property {NodeJS.Timeout} heartbeatTimer
 * @property {Map<string, Uint8Array>} blobStore
 * @property {Array<Object>} mcpTools   - McpToolDefinition[]
 * @property {Array<Object>} pendingExecs - {execId, execMsgId, toolCallId, toolName, decodedArgs}
 * @property {NodeJS.Timeout} _expiryTimer - auto-cleanup timer
 */

/** @type {Map<string, CursorSession>} */
const activeSessions = new Map();

/**
 * Derive a stable session key from model + first user message.
 * @param {string} model
 * @param {Array<{role: string, content: unknown}>} messages
 * @returns {string} 16-char hex string
 */
export function deriveSessionKey(model, messages) {
    const firstUserMsg = messages.find((m) => m.role === 'user')?.content ?? '';
    const text = typeof firstUserMsg === 'string' ? firstUserMsg : JSON.stringify(firstUserMsg);
    return createHash('sha256')
        .update(`${model}:${text.slice(0, 200)}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * Save a session, replacing any existing one for this key.
 * Starts the 120-second auto-expiry timer.
 * @param {string} key
 * @param {CursorSession} session
 */
export function saveSession(key, session) {
    // Cancel any existing expiry timer for this key
    const existing = activeSessions.get(key);
    if (existing?._expiryTimer) {
        clearTimeout(existing._expiryTimer);
    }

    // Start new expiry timer
    const expiryTimer = setTimeout(() => {
        logger.debug(`[CursorSession] Session ${key} expired after ${SESSION_TIMEOUT_MS}ms`);
        const s = activeSessions.get(key);
        if (s) {
            activeSessions.delete(key);
            _doCleanup(s);
        }
    }, SESSION_TIMEOUT_MS);
    // Allow Node.js to exit even if timer is pending
    if (expiryTimer.unref) expiryTimer.unref();

    session._expiryTimer = expiryTimer;
    activeSessions.set(key, session);
    logger.debug(`[CursorSession] Saved session ${key}, total active: ${activeSessions.size}`);
}

/**
 * Retrieve a session by key.
 * @param {string} key
 * @returns {CursorSession|undefined}
 */
export function getSession(key) {
    return activeSessions.get(key);
}

/**
 * Remove a session from the map (without closing the H2 connection).
 * Used when the caller takes ownership of the session for resumption.
 * @param {string} key
 * @returns {CursorSession|undefined}
 */
export function removeSession(key) {
    const session = activeSessions.get(key);
    if (session) {
        if (session._expiryTimer) clearTimeout(session._expiryTimer);
        activeSessions.delete(key);
        logger.debug(`[CursorSession] Removed session ${key}, total active: ${activeSessions.size}`);
    }
    return session;
}

/**
 * Clean up a session: stop heartbeat, close H2 stream and client.
 * Safe to call multiple times.
 * @param {CursorSession} session
 */
export function cleanupSession(session) {
    if (!session) return;
    if (session._expiryTimer) {
        clearTimeout(session._expiryTimer);
        session._expiryTimer = null;
    }
    _doCleanup(session);
}

/**
 * Remove and clean up a session by key.
 * @param {string} key
 */
export function removeAndCleanupSession(key) {
    const session = activeSessions.get(key);
    if (session) {
        activeSessions.delete(key);
        cleanupSession(session);
    }
}

/**
 * Clean up all active sessions. Called on process exit.
 */
export function cleanupAllSessions() {
    for (const [key, session] of activeSessions) {
        activeSessions.delete(key);
        _doCleanup(session);
    }
    logger.debug('[CursorSession] All sessions cleaned up');
}

/**
 * Returns the number of currently active sessions.
 * @returns {number}
 */
export function getActiveSessionCount() {
    return activeSessions.size;
}

// ============================================================================
// Internal helpers
// ============================================================================

function _doCleanup(session) {
    if (session.heartbeatTimer) {
        try { clearInterval(session.heartbeatTimer); } catch {}
        session.heartbeatTimer = null;
    }
    if (session.h2Stream) {
        try { session.h2Stream.close(); } catch {}
    }
    if (session.h2Client) {
        try { session.h2Client.close(); } catch {}
    }
}

// Register process exit handler to clean up all sessions
process.on('exit', cleanupAllSessions);
