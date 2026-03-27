/**
 * codex-websocket.js
 *
 * WebSocket relay for Codex (OpenAI Responses API WebSocket transport).
 *
 * When the downstream client connects via WebSocket, this module:
 *   1. Upgrades the incoming HTTP request to a WebSocket connection
 *   2. Establishes an upstream WebSocket to the Codex backend
 *   3. Relays messages between downstream ↔ upstream
 *   4. Manages session-scoped connection reuse, ping/pong, idle timeout
 *   5. Falls back to HTTP SSE if WebSocket upgrade fails (status 426)
 *
 * Ported from CLIProxyAPIPlus internal/runtime/executor/codex_websockets_executor.go
 */

import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import logger from '../../utils/logger.js';
import http from 'http';

// ============================================================================
// Constants
// ============================================================================

const CODEX_WS_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CODEX_WS_HANDSHAKE_TIMEOUT = 30 * 1000; // 30 seconds
const CODEX_WS_PING_INTERVAL = 30 * 1000; // 30 seconds
const CODEX_WS_BETA_HEADER = 'responses_websockets=2026-02-06';

// ============================================================================
// Session Manager
// ============================================================================

/**
 * Manages WebSocket sessions for connection reuse within execution sessions.
 */
class CodexWebSocketSessionManager {
    constructor() {
        /** @type {Map<string, CodexWebSocketSession>} */
        this.sessions = new Map();
    }

    /**
     * Get or create a session for the given ID.
     * @param {string} sessionId
     * @returns {CodexWebSocketSession|null}
     */
    getOrCreate(sessionId) {
        if (!sessionId) return null;
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = new CodexWebSocketSession(sessionId);
            this.sessions.set(sessionId, session);
        }
        return session;
    }

    /**
     * Close and remove a session.
     * @param {string} sessionId
     */
    close(sessionId) {
        if (!sessionId) return;
        const session = this.sessions.get(sessionId);
        if (session) {
            session.destroy();
            this.sessions.delete(sessionId);
        }
    }

    /**
     * Close all sessions.
     */
    closeAll() {
        for (const [id, session] of this.sessions) {
            session.destroy();
        }
        this.sessions.clear();
    }
}

/**
 * A single WebSocket session that may hold a reusable upstream connection.
 */
class CodexWebSocketSession {
    constructor(sessionId) {
        this.sessionId = sessionId;
        /** @type {WebSocket|null} */
        this.upstreamConn = null;
        this.upstreamUrl = null;
        this.pingInterval = null;
    }

    /**
     * Check if this session has a live upstream connection.
     */
    hasConnection() {
        return this.upstreamConn && this.upstreamConn.readyState === WebSocket.OPEN;
    }

    /**
     * Set the upstream connection and start ping/pong keepalive.
     */
    setConnection(conn, wsUrl) {
        this.upstreamConn = conn;
        this.upstreamUrl = wsUrl;
        this._startPing();
    }

    /**
     * Invalidate the current upstream connection (e.g., on error).
     */
    invalidate(reason) {
        logger.info(`[Codex WS] Session ${this.sessionId} invalidating upstream: ${reason}`);
        this._stopPing();
        if (this.upstreamConn) {
            try { this.upstreamConn.close(); } catch { /* ignore */ }
            this.upstreamConn = null;
        }
    }

    /**
     * Destroy the session entirely.
     */
    destroy() {
        this._stopPing();
        if (this.upstreamConn) {
            try { this.upstreamConn.close(); } catch { /* ignore */ }
            this.upstreamConn = null;
        }
    }

    _startPing() {
        this._stopPing();
        this.pingInterval = setInterval(() => {
            if (this.upstreamConn && this.upstreamConn.readyState === WebSocket.OPEN) {
                this.upstreamConn.ping();
            }
        }, CODEX_WS_PING_INTERVAL);
    }

    _stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
}

// ============================================================================
// URL Helpers
// ============================================================================

/**
 * Convert an HTTP(S) URL to a WebSocket URL.
 * @param {string} httpUrl
 * @returns {string}
 */
function buildWebSocketUrl(httpUrl) {
    const parsed = new URL(httpUrl);
    if (parsed.protocol === 'https:') {
        parsed.protocol = 'wss:';
    } else {
        parsed.protocol = 'ws:';
    }
    return parsed.toString();
}

/**
 * Wrap the request body with `type: "response.create"` for WebSocket protocol.
 * @param {object} body
 * @returns {object}
 */
function buildWebSocketRequestBody(body) {
    if (!body) return null;
    return { ...body, type: 'response.create' };
}

// ============================================================================
// Upstream Connection
// ============================================================================

/**
 * Create a WebSocket agent that respects proxy configuration.
 * Uses lazy imports to avoid circular dependency issues with tls-sidecar.
 * @param {object} config - Provider config
 * @returns {Promise<import('http').Agent|undefined>}
 */
async function createWebSocketAgent(config) {
    let getProxyConfigForProvider;
    try {
        const mod = await import('../../utils/proxy-utils.js');
        getProxyConfigForProvider = mod.getProxyConfigForProvider;
    } catch {
        return undefined;
    }

    const proxyConfig = getProxyConfigForProvider(config, 'openai-codex-oauth');
    if (!proxyConfig?.proxyUrl) return undefined;

    const proxyUrl = proxyConfig.proxyUrl;
    try {
        const parsed = new URL(proxyUrl);
        if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
            const { SocksProxyAgent } = await import('socks-proxy-agent');
            return new SocksProxyAgent(proxyUrl);
        }
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        return new HttpsProxyAgent(proxyUrl);
    } catch {
        logger.warn(`[Codex WS] Invalid proxy URL: ${proxyUrl}`);
        return undefined;
    }
}

/**
 * Dial an upstream Codex WebSocket connection.
 *
 * @param {string} wsUrl - WebSocket URL
 * @param {object} headers - Request headers
 * @param {object} config - Provider config
 * @returns {Promise<WebSocket>}
 */
async function dialUpstream(wsUrl, headers, config) {
    const agent = await createWebSocketAgent(config);
    return new Promise((resolve, reject) => {
        const opts = {
            headers,
            handshakeTimeout: CODEX_WS_HANDSHAKE_TIMEOUT,
            perMessageDeflate: true,
        };
        if (agent) opts.agent = agent;

        const ws = new WebSocket(wsUrl, opts);

        const timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error('WebSocket handshake timeout'));
        }, CODEX_WS_HANDSHAKE_TIMEOUT);

        ws.once('open', () => {
            clearTimeout(timeout);
            resolve(ws);
        });

        ws.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        // Handle unexpected close during handshake
        ws.once('unexpected-response', (_req, res) => {
            clearTimeout(timeout);
            const status = res.statusCode;
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                const err = new Error(`WebSocket upgrade failed: ${status}`);
                err.statusCode = status;
                err.body = body;
                reject(err);
            });
        });
    });
}

// ============================================================================
// WebSocket Error Parsing
// ============================================================================

/**
 * Parse an upstream WebSocket error message.
 * @param {string} data - Raw message text
 * @returns {{ isError: boolean, status?: number, payload?: string }}
 */
function parseWebSocketError(data) {
    try {
        const parsed = JSON.parse(data);
        if (parsed.type !== 'error') return { isError: false };
        const status = parsed.status || parsed.status_code || 0;
        if (status <= 0) return { isError: false };

        let errorPayload;
        if (parsed.error) {
            errorPayload = JSON.stringify({ error: parsed.error });
        } else {
            errorPayload = JSON.stringify({
                error: { type: 'server_error', message: http.STATUS_CODES[status] || 'Unknown error' }
            });
        }
        return { isError: true, status, payload: errorPayload, headers: parsed.headers };
    } catch {
        return { isError: false };
    }
}

/**
 * Normalize `response.done` to `response.completed`.
 * @param {string} data
 * @returns {string}
 */
function normalizeCompletion(data) {
    try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'response.done') {
            parsed.type = 'response.completed';
            return JSON.stringify(parsed);
        }
        return data;
    } catch {
        return data;
    }
}

// ============================================================================
// WebSocket Relay Handler
// ============================================================================

/** @type {CodexWebSocketSessionManager} */
const sessionManager = new CodexWebSocketSessionManager();

/**
 * Create a WebSocketServer instance attached to the given HTTP server.
 * Handles Codex WebSocket relay at `/v1/responses` path.
 *
 * @param {http.Server} server - The HTTP server to attach to
 * @param {object} config - Server configuration
 * @param {Function} getApiServiceFn - Function to resolve the current API service adapter
 * @returns {WebSocketServer}
 */
export function createCodexWebSocketHandler(server, config, getApiServiceFn) {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Only handle Codex Responses WebSocket path
        if (pathname !== '/v1/responses') {
            socket.destroy();
            return;
        }

        // Check API key authentication
        const authHeader = req.headers['authorization'];
        const apiKey = config.REQUIRED_API_KEY;
        if (apiKey && apiKey !== 'none') {
            const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
            if (token !== apiKey) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', async (downstream, req) => {
        logger.info('[Codex WS] Downstream WebSocket connected');

        // Extract session ID from headers for connection reuse
        const sessionId = req.headers['session_id'] || req.headers['x-codex-session-id'] || '';

        // Set idle timeout — close if no messages for 5 minutes
        let idleTimer = setTimeout(() => {
            logger.info('[Codex WS] Idle timeout, closing downstream');
            downstream.close(1000, 'idle timeout');
        }, CODEX_WS_IDLE_TIMEOUT);

        const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                logger.info('[Codex WS] Idle timeout, closing downstream');
                downstream.close(1000, 'idle timeout');
            }, CODEX_WS_IDLE_TIMEOUT);
        };

        // Handle messages from downstream client
        downstream.on('message', async (rawMessage) => {
            resetIdle();
            let message;
            try {
                message = JSON.parse(rawMessage.toString());
            } catch {
                downstream.send(JSON.stringify({
                    type: 'error',
                    status: 400,
                    error: { type: 'invalid_request', message: 'Invalid JSON' }
                }));
                return;
            }

            try {
                await handleDownstreamMessage(downstream, message, req, config, getApiServiceFn, sessionId);
            } catch (err) {
                logger.error(`[Codex WS] Error handling message: ${err.message}`);
                downstream.send(JSON.stringify({
                    type: 'error',
                    status: 500,
                    error: { type: 'server_error', message: err.message }
                }));
            }
        });

        downstream.on('close', () => {
            clearTimeout(idleTimer);
            logger.info('[Codex WS] Downstream WebSocket closed');
        });

        downstream.on('error', (err) => {
            clearTimeout(idleTimer);
            logger.error(`[Codex WS] Downstream error: ${err.message}`);
        });
    });

    // Periodic cleanup of dead sessions
    const cleanupInterval = setInterval(() => {
        for (const [id, session] of sessionManager.sessions) {
            if (!session.hasConnection()) {
                sessionManager.close(id);
            }
        }
    }, 60 * 1000);

    // Cleanup on server close
    server.on('close', () => {
        clearInterval(cleanupInterval);
        sessionManager.closeAll();
        wss.close();
    });

    return wss;
}

/**
 * Handle a single message from the downstream WebSocket client.
 *
 * For each `response.create` message:
 *   1. Resolve the Codex API service (with token, headers)
 *   2. Connect (or reuse) upstream WebSocket
 *   3. Forward the message and relay responses back to downstream
 */
async function handleDownstreamMessage(downstream, message, req, config, getApiServiceFn, sessionId) {
    // Only handle response.create messages
    if (message.type && message.type !== 'response.create') {
        logger.debug(`[Codex WS] Ignoring non-create message type: ${message.type}`);
        return;
    }

    // Resolve the Codex API service adapter
    const { adapter, codexService } = await resolveCodexService(getApiServiceFn, req);
    if (!codexService) {
        downstream.send(JSON.stringify({
            type: 'error',
            status: 503,
            error: { type: 'service_unavailable', message: 'Codex service not available' }
        }));
        return;
    }

    // Build upstream WebSocket URL
    const baseUrl = codexService.baseUrl || 'https://chatgpt.com/backend-api/codex';
    const wsUrl = buildWebSocketUrl(`${baseUrl}/responses`);

    // Build upstream request headers
    const model = message.model || 'gpt-5';
    const body = await codexService.prepareRequestBody(model, { ...message }, true);
    const wsBody = buildWebSocketRequestBody(body);
    const upstreamHeaders = buildUpstreamHeaders(codexService, req, body.prompt_cache_key);

    // Get or create session for connection reuse
    const session = sessionManager.getOrCreate(sessionId || `anon-${Date.now()}`);

    let upstream;
    try {
        if (session.hasConnection()) {
            upstream = session.upstreamConn;
            logger.debug(`[Codex WS] Reusing upstream connection for session ${session.sessionId}`);
        } else {
            upstream = await dialUpstream(wsUrl, upstreamHeaders, codexService.config);
            session.setConnection(upstream, wsUrl);
            logger.info(`[Codex WS] Upstream connected: ${wsUrl}`);
        }
    } catch (err) {
        logger.error(`[Codex WS] Upstream connect failed: ${err.message}`);
        // If upgrade failed with specific status, pass it along
        if (err.statusCode) {
            downstream.send(JSON.stringify({
                type: 'error',
                status: err.statusCode,
                error: { type: 'upstream_error', message: `WebSocket upgrade failed: ${err.statusCode}` }
            }));
        } else {
            downstream.send(JSON.stringify({
                type: 'error',
                status: 502,
                error: { type: 'upstream_error', message: err.message }
            }));
        }
        return;
    }

    // Send message to upstream
    try {
        upstream.send(JSON.stringify(wsBody));
    } catch (err) {
        logger.warn(`[Codex WS] Send failed, reconnecting: ${err.message}`);
        session.invalidate('send_error');
        try {
            upstream = await dialUpstream(wsUrl, upstreamHeaders, codexService.config);
            session.setConnection(upstream, wsUrl);
            upstream.send(JSON.stringify(wsBody));
        } catch (retryErr) {
            downstream.send(JSON.stringify({
                type: 'error',
                status: 502,
                error: { type: 'upstream_error', message: retryErr.message }
            }));
            return;
        }
    }

    // Relay upstream messages back to downstream
    await relayUpstreamToDownstream(upstream, downstream, session);
}

/**
 * Relay messages from upstream WebSocket to downstream until response.completed.
 */
function relayUpstreamToDownstream(upstream, downstream, session) {
    return new Promise((resolve) => {
        const onMessage = (rawData) => {
            const data = rawData.toString().trim();
            if (!data) return;

            // Check for error
            const errResult = parseWebSocketError(data);
            if (errResult.isError) {
                session.invalidate('upstream_error');
                downstream.send(JSON.stringify({
                    type: 'error',
                    status: errResult.status,
                    error: JSON.parse(errResult.payload).error
                }));
                cleanup();
                resolve();
                return;
            }

            // Normalize response.done → response.completed
            const normalized = normalizeCompletion(data);

            // Forward to downstream
            if (downstream.readyState === WebSocket.OPEN) {
                downstream.send(normalized);
            }

            // Check if response is complete
            try {
                const parsed = JSON.parse(normalized);
                if (parsed.type === 'response.completed') {
                    cleanup();
                    resolve();
                    return;
                }
            } catch { /* not JSON or no type field */ }
        };

        const onError = (err) => {
            logger.error(`[Codex WS] Upstream error during relay: ${err.message}`);
            session.invalidate('upstream_error');
            if (downstream.readyState === WebSocket.OPEN) {
                downstream.send(JSON.stringify({
                    type: 'error',
                    status: 502,
                    error: { type: 'upstream_error', message: err.message }
                }));
            }
            cleanup();
            resolve();
        };

        const onClose = () => {
            session.invalidate('upstream_closed');
            cleanup();
            resolve();
        };

        const cleanup = () => {
            upstream.removeListener('message', onMessage);
            upstream.removeListener('error', onError);
            upstream.removeListener('close', onClose);
        };

        upstream.on('message', onMessage);
        upstream.on('error', onError);
        upstream.on('close', onClose);
    });
}

/**
 * Build upstream WebSocket headers from the Codex service.
 */
function buildUpstreamHeaders(codexService, req, cacheId) {
    const headers = {
        'Authorization': `Bearer ${codexService.accessToken}`,
        'User-Agent': `codex_cli_rs/${codexService.constructor === Object ? '0.111.0' : '0.111.0'} (Windows 10.0.26100; x86_64) WindowsTerminal`,
        'Originator': 'codex_cli_rs',
        'OpenAI-Beta': CODEX_WS_BETA_HEADER,
        'Content-Type': 'application/json',
    };

    if (codexService.accountId) {
        headers['Chatgpt-Account-Id'] = codexService.accountId;
    }

    if (cacheId) {
        headers['Session_id'] = cacheId;
        headers['Conversation_id'] = cacheId;
    }

    // Forward select headers from downstream request
    const forwardHeaders = [
        'x-codex-beta-features',
        'x-codex-turn-state',
        'x-codex-turn-metadata',
        'x-client-request-id',
        'version',
    ];
    for (const key of forwardHeaders) {
        const val = req.headers[key];
        if (val) headers[key] = val;
    }

    // Default beta features
    if (!headers['x-codex-beta-features']) {
        headers['x-codex-beta-features'] = 'powershell_utf8';
    }

    return headers;
}

/**
 * Resolve the CodexApiService from the adapter registry.
 */
async function resolveCodexService(getApiServiceFn, req) {
    try {
        // Try to get the provider from the request headers
        const modelProvider = req.headers['model-provider'];
        const adapter = getApiServiceFn(modelProvider || 'openai-codex-oauth');
        if (!adapter) {
            return { adapter: null, codexService: null };
        }
        // Access the underlying CodexApiService
        const codexService = adapter.codexApiService;
        if (!codexService) {
            return { adapter, codexService: null };
        }
        if (!codexService.isInitialized) {
            await codexService.initialize();
        }
        return { adapter, codexService };
    } catch (err) {
        logger.error(`[Codex WS] Failed to resolve Codex service: ${err.message}`);
        return { adapter: null, codexService: null };
    }
}

// ============================================================================
// Exports
// ============================================================================

export {
    CodexWebSocketSessionManager,
    buildWebSocketUrl,
    buildWebSocketRequestBody,
    parseWebSocketError,
    normalizeCompletion,
    sessionManager,
};
