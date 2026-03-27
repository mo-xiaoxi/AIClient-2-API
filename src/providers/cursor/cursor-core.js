/**
 * cursor-core.js
 *
 * Main Cursor provider service. Implements ApiServiceAdapter interface.
 * Accepts OpenAI-format requests and translates them to Cursor's
 * HTTP/2 + Connect Protocol + Protobuf API.
 */

import { randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import logger from '../../utils/logger.js';
import { CursorTokenStore } from './cursor-token-store.js';
import {
    buildCursorAgentRequest,
    buildHeartbeatBytes,
    buildMcpToolDefinitions,
    buildToolResultFrames,
    parseMessages,
    processAgentServerMessage,
} from './cursor-protobuf.js';
import {
    CONNECT_END_STREAM_FLAG,
    frameConnectMessage,
    parseConnectErrorFrame,
    h2RequestStream,
} from './cursor-h2.js';
import {
    deriveSessionKey,
    getSession,
    removeSession,
    saveSession,
    cleanupSession,
} from './cursor-session.js';
import {
    isTruncated,
    autoContinueFull,
    autoContinueStream,
} from './cursor-truncation.js';
import { compressMessages } from './cursor-compression.js';
import { createStreamGuard } from './cursor-stream-guard.js';
import { preprocessImages } from './cursor-vision.js';
import {
    GetUsableModelsRequestSchema,
    GetUsableModelsResponseSchema,
} from './proto/agent_pb.js';

// ============================================================================
// Constants
// ============================================================================

const CURSOR_API_URL = 'https://api2.cursor.sh';
const CURSOR_CLIENT_VERSION = 'cli-2026.02.13-41ac335';
const GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';

// Degenerate loop detection defaults (overridable via env)
const DEFAULT_MAX_REPEAT_TOKENS = parseInt(process.env.CURSOR_MAX_REPEAT_TOKENS, 10) || 8;
const DEFAULT_MAX_TOOL_CALL_DEPTH = parseInt(process.env.CURSOR_MAX_TOOL_CALL_DEPTH, 10) || 10;

// Auto-continuation defaults (overridable via env)
const DEFAULT_MAX_AUTO_CONTINUE = parseInt(process.env.CURSOR_MAX_AUTO_CONTINUE, 10) || 3;

// History compression defaults (disabled by default — opt-in via env)
const CURSOR_COMPRESSION_ENABLED = process.env.CURSOR_COMPRESSION_ENABLED === 'true';
const CURSOR_COMPRESSION_LEVEL = parseInt(process.env.CURSOR_COMPRESSION_LEVEL, 10) || 2;
const CURSOR_COMPRESSION_KEEP_RECENT = parseInt(process.env.CURSOR_COMPRESSION_KEEP_RECENT, 10) || undefined;
const CURSOR_MAX_HISTORY_TOKENS = parseInt(process.env.CURSOR_MAX_HISTORY_TOKENS, 10) || 120_000;

// Stream guard defaults (disabled by default — opt-in via env)
const CURSOR_STREAM_GUARD_ENABLED = process.env.CURSOR_STREAM_GUARD_ENABLED === 'true';
const CURSOR_WARMUP_CHARS = parseInt(process.env.CURSOR_WARMUP_CHARS, 10) || 96;
const CURSOR_GUARD_CHARS = parseInt(process.env.CURSOR_GUARD_CHARS, 10) || 256;

// HTML token pattern for cross-chunk splicing detection
const HTML_TOKEN_RE = /(<\/?[a-z][a-z0-9]*\s*\/?>|&[a-z]+;)/gi;

const FALLBACK_MODELS = [
    { id: 'auto', name: 'Auto (Smart Routing)' },
    { id: 'premium', name: 'Premium (Smart Routing)' },
    { id: 'composer-2', name: 'Composer 2' },
    { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet' },
    { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'cursor-small', name: 'Cursor Small' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
];

// 模型缓存 TTL（5 分钟），避免缓存过期后无法获取新模型
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// Degenerate loop detection — module-level functions
// ============================================================================

/**
 * Detects degenerate text output loops.
 *
 * Two detection strategies:
 *   1. Short token (≤20 chars) consecutive repeat — when the same small delta
 *      arrives repeatedly it signals the model is stuck.
 *   2. HTML token cross-chunk splicing — partial HTML tokens (e.g. `<`, `br`,
 *      `>`) are buffered in state.tagBuffer; once a complete HTML token is
 *      assembled it is treated as the effective delta for repeat counting.
 *
 * @param {string} text     - Incoming text delta from onText callback
 * @param {object} state    - Mutable state shared across calls in one request:
 *                            { lastDelta, repeatCount, tagBuffer, aborted }
 * @param {object} config   - Optional overrides: { maxRepeatTokens }
 * @returns {boolean}       - true when a degenerate loop is detected
 */
export function checkDegenerateLoop(text, state, config) {
    if (!text) return false;

    const maxRepeat = (config && config.maxRepeatTokens != null)
        ? config.maxRepeatTokens
        : DEFAULT_MAX_REPEAT_TOKENS;

    // Append incoming text to the HTML tag buffer
    state.tagBuffer += text;

    // Try to extract complete HTML tokens from the buffer
    HTML_TOKEN_RE.lastIndex = 0;
    const matches = state.tagBuffer.match(HTML_TOKEN_RE);
    if (matches && matches.length > 0) {
        // Use the last complete HTML token as the effective delta
        const htmlToken = matches[matches.length - 1];
        // Clear consumed portion from buffer — keep only what follows the last match
        const lastMatchIdx = state.tagBuffer.lastIndexOf(htmlToken);
        state.tagBuffer = state.tagBuffer.slice(lastMatchIdx + htmlToken.length);

        // Apply repeat-counting logic on the HTML token
        if (htmlToken === state.lastDelta) {
            state.repeatCount++;
        } else {
            state.lastDelta = htmlToken;
            state.repeatCount = 1;
        }

        if (state.repeatCount >= maxRepeat) {
            logger.warn(`[CursorApiService] Degenerate loop detected: HTML token "${htmlToken}" repeated ${state.repeatCount} times`);
            return true;
        }
        return false;
    }

    // No complete HTML token found — check if buffer might be mid-token
    // (starts with '<' or '&', potentially still assembling)
    const mightBeHtmlPrefix = /^[<&]/.test(state.tagBuffer) && state.tagBuffer.length < 32;
    if (mightBeHtmlPrefix) {
        // Not enough info yet — don't apply short-token logic to partial HTML
        return false;
    }

    // Not an HTML token situation — flush the buffer into plain text logic
    const effectiveDelta = state.tagBuffer;
    state.tagBuffer = '';

    // Only apply short-token repeat detection
    if (effectiveDelta.length > 20) {
        // Long tokens: reset repeat counter, they are considered normal
        state.lastDelta = effectiveDelta;
        state.repeatCount = 1;
        return false;
    }

    if (effectiveDelta === state.lastDelta) {
        state.repeatCount++;
    } else {
        state.lastDelta = effectiveDelta;
        state.repeatCount = 1;
    }

    if (state.repeatCount >= maxRepeat) {
        logger.warn(`[CursorApiService] Degenerate loop detected: token "${effectiveDelta}" repeated ${state.repeatCount} times`);
        return true;
    }

    return false;
}

/**
 * Detects tool-call loops.
 *
 * Two detection strategies:
 *   1. Total depth limit — if more than maxToolCallDepth tool calls have been
 *      made in this session the model is considered stuck in a tool loop.
 *   2. Consecutive identical tool+args — three consecutive calls to the same
 *      tool with identical arguments indicate the model is not making progress.
 *
 * @param {object} exec   - Tool execution descriptor: { toolName, decodedArgs }
 * @param {object} state  - Mutable state: { toolCallDepth, toolCallHistory }
 * @param {object} config - Optional overrides: { maxToolCallDepth }
 * @returns {boolean}     - true when a loop is detected
 */
export function checkToolCallLoop(exec, state, config) {
    const maxDepth = (config && config.maxToolCallDepth != null)
        ? config.maxToolCallDepth
        : DEFAULT_MAX_TOOL_CALL_DEPTH;

    state.toolCallDepth++;

    if (state.toolCallDepth >= maxDepth) {
        logger.warn(`[CursorApiService] Tool call loop detected: depth ${state.toolCallDepth} reached limit ${maxDepth}`);
        return true;
    }

    // Record this call in history (keep last 3 entries)
    const key = `${exec.toolName}::${exec.decodedArgs}`;
    state.toolCallHistory.push(key);
    if (state.toolCallHistory.length > 3) {
        state.toolCallHistory.shift();
    }

    // Check if the last 3 entries are all the same
    if (
        state.toolCallHistory.length === 3 &&
        state.toolCallHistory[0] === state.toolCallHistory[1] &&
        state.toolCallHistory[1] === state.toolCallHistory[2]
    ) {
        logger.warn(`[CursorApiService] Tool call loop detected: tool "${exec.toolName}" called 3 consecutive times with identical args`);
        return true;
    }

    return false;
}

// ============================================================================
// CursorApiService
// ============================================================================

export class CursorApiService {
    constructor(config) {
        this.config = config;
        this.uuid = config.uuid;
        this.credFilePath = config.CURSOR_OAUTH_CREDS_FILE_PATH;
        this._tokenStore = null;
        this.isInitialized = false;
        this._cachedModels = null;
        this._modelsCachedAt = 0;
    }

    // ---------- Lifecycle ----------

    async initialize() {
        if (this.isInitialized) return;
        const store = new CursorTokenStore(this.credFilePath);
        await store.initialize();
        this._tokenStore = store;
        this.isInitialized = true;
        logger.info(`[CursorApiService] Initialized (uuid=${this.uuid})`);
    }

    // ---------- ApiServiceAdapter interface ----------

    /**
     * Non-streaming generation. Returns OpenAI Chat Completion format.
     */
    async generateContent(model, requestBody) {
        await this._ensureInitialized();
        const accessToken = await this._tokenStore.getValidAccessToken();

        let messages = requestBody.messages || [];
        messages = await preprocessImages(messages);
        if (CURSOR_COMPRESSION_ENABLED) {
            messages = compressMessages(messages, {
                level: CURSOR_COMPRESSION_LEVEL,
                keepRecent: CURSOR_COMPRESSION_KEEP_RECENT,
                maxHistoryTokens: CURSOR_MAX_HISTORY_TOKENS,
            });
        }
        const { systemPrompt, userText, images, turns, toolResults } = parseMessages(messages);
        const tools = requestBody.tools || [];

        if (!userText && toolResults.length === 0) {
            throw Object.assign(new Error('No user message found'), { status: 400 });
        }

        const sessionKey = deriveSessionKey(model, requestBody.messages || []);

        // Resume existing session with tool results
        if (toolResults.length > 0) {
            const session = getSession(sessionKey);
            if (session) {
                removeSession(sessionKey);
                const { h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, pendingExecs } = session;
                const frames = buildToolResultFrames(pendingExecs, toolResults);
                for (const frame of frames) {
                    if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(frame);
                }
                h2Stream.removeAllListeners('data');
                h2Stream.removeAllListeners('end');
                h2Stream.removeAllListeners('error');
                return this._collectFromH2({ h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, model, sessionKey, systemPrompt, accessToken });
            }
        }

        const mcpTools = buildMcpToolDefinitions(tools);
        const { requestBytes, blobStore } = buildCursorAgentRequest({
            modelId: model,
            systemPrompt,
            userText,
            images,
            turns,
            mcpTools,
        });

        const { client: h2Client, stream: h2Stream } = h2RequestStream({ accessToken });
        h2Stream.write(frameConnectMessage(requestBytes));

        const heartbeatTimer = setInterval(() => {
            if (!h2Stream.closed && !h2Stream.destroyed) {
                h2Stream.write(buildHeartbeatBytes());
            }
        }, 5_000);

        return this._collectFromH2({ h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, model, sessionKey, systemPrompt, accessToken });
    }

    /**
     * Streaming generation. Yields OpenAI SSE-compatible chunk objects.
     */
    async *generateContentStream(model, requestBody) {
        await this._ensureInitialized();
        const accessToken = await this._tokenStore.getValidAccessToken();

        let messages = requestBody.messages || [];
        messages = await preprocessImages(messages);
        if (CURSOR_COMPRESSION_ENABLED) {
            messages = compressMessages(messages, {
                level: CURSOR_COMPRESSION_LEVEL,
                keepRecent: CURSOR_COMPRESSION_KEEP_RECENT,
                maxHistoryTokens: CURSOR_MAX_HISTORY_TOKENS,
            });
        }
        const { systemPrompt, userText, images, turns, toolResults } = parseMessages(messages);
        const tools = requestBody.tools || [];

        if (!userText && toolResults.length === 0) {
            throw Object.assign(new Error('No user message found'), { status: 400 });
        }

        const sessionKey = deriveSessionKey(model, requestBody.messages || []);

        // Resume with tool results
        if (toolResults.length > 0) {
            const session = getSession(sessionKey);
            if (session) {
                removeSession(sessionKey);
                const { h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, pendingExecs } = session;
                const frames = buildToolResultFrames(pendingExecs, toolResults);
                for (const frame of frames) {
                    if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(frame);
                }
                h2Stream.removeAllListeners('data');
                h2Stream.removeAllListeners('end');
                h2Stream.removeAllListeners('error');
                yield* this._streamFromH2({ h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, model, sessionKey, systemPrompt, accessToken });
                return;
            }
        }

        const mcpTools = buildMcpToolDefinitions(tools);
        const { requestBytes, blobStore } = buildCursorAgentRequest({
            modelId: model,
            systemPrompt,
            userText,
            images,
            turns,
            mcpTools,
        });

        const { client: h2Client, stream: h2Stream } = h2RequestStream({ accessToken });
        h2Stream.write(frameConnectMessage(requestBytes));

        const heartbeatTimer = setInterval(() => {
            if (!h2Stream.closed && !h2Stream.destroyed) {
                h2Stream.write(buildHeartbeatBytes());
            }
        }, 5_000);

        yield* this._streamFromH2({ h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, model, sessionKey, systemPrompt, accessToken });
    }

    /**
     * List available models. Returns OpenAI-format model list.
     */
    async listModels() {
        // 缓存未过期时直接返回
        if (this._cachedModels && (Date.now() - this._modelsCachedAt) < MODEL_CACHE_TTL_MS) {
            return this._cachedModels;
        }

        try {
            await this._ensureInitialized();
            const accessToken = await this._tokenStore.getValidAccessToken();
            const discovered = await this._fetchUsableModels(accessToken);
            const models = (discovered && discovered.length > 0) ? discovered : FALLBACK_MODELS;
            this._cachedModels = {
                object: 'list',
                data: models.map((m) => ({
                    id: m.id,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'cursor',
                })),
            };
            this._modelsCachedAt = Date.now();
        } catch (err) {
            logger.warn(`[CursorApiService] listModels failed, using fallback: ${err.message}`);
            this._cachedModels = {
                object: 'list',
                data: FALLBACK_MODELS.map((m) => ({
                    id: m.id,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'cursor',
                })),
            };
            this._modelsCachedAt = Date.now();
        }

        return this._cachedModels;
    }

    /**
     * Refresh token if near expiry.
     */
    async refreshToken() {
        if (!this.isInitialized) await this.initialize();
        if (this.isExpiryDateNear()) {
            logger.info('[CursorApiService] Token near expiry, refreshing...');
            await this._tokenStore._doRefresh();
        }
    }

    /**
     * Force refresh token regardless of expiry.
     */
    async forceRefreshToken() {
        if (!this.isInitialized) await this.initialize();
        await this._tokenStore._doRefresh();
    }

    /**
     * Returns true if access token expires within 5 minutes.
     */
    isExpiryDateNear() {
        if (!this._tokenStore) return false;
        return this._tokenStore.isExpiryDateNear(5);
    }

    /**
     * Cursor has no usage limits API — return empty.
     */
    async getUsageLimits() {
        return {};
    }

    // ---------- Internal: shared H2 consumers ----------

    /**
     * Non-streaming H2 consumer. Collects text from the stream and returns
     * an OpenAI Chat Completion response. Supports tool_calls and thinking.
     *
     * Used by both initial requests and session resumption.
     */
    _collectFromH2({ h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, model, sessionKey, systemPrompt = '', accessToken = null }) {
        const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 28)}`;
        const created = Math.floor(Date.now() / 1000);

        let fullText = '';
        let thinkingText = '';
        let pendingBuffer = Buffer.alloc(0);
        const toolCalls = [];
        const pendingExecs = [];
        let resolved = false;

        const degenerateState = {
            lastDelta: '',
            repeatCount: 0,
            tagBuffer: '',
            aborted: false,
        };

        const buildResponse = (finishReason = 'stop') => {
            const content = thinkingText
                ? `<think>${thinkingText}</think>${fullText}`
                : fullText;
            const message = { role: 'assistant', content: content || null };
            if (toolCalls.length > 0) {
                message.tool_calls = toolCalls;
            }
            return {
                id,
                object: 'chat.completion',
                created,
                model,
                choices: [{ index: 0, message, finish_reason: finishReason }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
        };

        return new Promise((resolve, reject) => {
            h2Stream.on('data', (incoming) => {
                if (resolved) return;
                pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
                while (pendingBuffer.length >= 5) {
                    const flags = pendingBuffer[0];
                    const msgLen = pendingBuffer.readUInt32BE(1);
                    if (pendingBuffer.length < 5 + msgLen) break;
                    const msgBytes = pendingBuffer.subarray(5, 5 + msgLen);
                    pendingBuffer = pendingBuffer.subarray(5 + msgLen);
                    if (flags & CONNECT_END_STREAM_FLAG) {
                        const errFrame = parseConnectErrorFrame(msgBytes);
                        if (errFrame) {
                            logger.error(`[CursorApiService] Cursor API error (${errFrame.error.connectCode}): ${errFrame.error.message}`);
                            resolved = true;
                            reject(errFrame.error);
                            return;
                        }
                        continue;
                    }
                    try {
                        processAgentServerMessage(msgBytes, {
                            blobStore,
                            mcpTools,
                            sendFrame: (data) => {
                                if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(data);
                            },
                            onText: (text, isThinking) => {
                                if (isThinking) {
                                    thinkingText += text;
                                } else {
                                    if (!degenerateState.aborted && checkDegenerateLoop(text, degenerateState, {})) {
                                        degenerateState.aborted = true;
                                        resolved = true;
                                        clearInterval(heartbeatTimer);
                                        try { h2Client.close(); } catch {}
                                        resolve(buildResponse('stop'));
                                        return;
                                    }
                                    if (!degenerateState.aborted) {
                                        fullText += text;
                                    }
                                }
                            },
                            onMcpExec: (exec) => {
                                pendingExecs.push(exec);
                                toolCalls.push({
                                    id: exec.toolCallId,
                                    type: 'function',
                                    function: { name: exec.toolName, arguments: exec.decodedArgs },
                                });
                                // Save session for caller to resume with tool results
                                saveSession(sessionKey, {
                                    h2Client, h2Stream, heartbeatTimer,
                                    blobStore, mcpTools,
                                    pendingExecs,
                                });
                                resolved = true;
                                resolve(buildResponse('tool_calls'));
                            },
                        });
                    } catch (err) {
                        logger.warn(`[CursorApiService] processAgentServerMessage error: ${err.message}`);
                    }
                }
            });

            h2Stream.on('end', async () => {
                if (resolved) return;
                clearInterval(heartbeatTimer);
                try { h2Client.close(); } catch {}

                // Truncation detection & auto-continue (only for non-tool-call responses)
                if (fullText && toolCalls.length === 0 && isTruncated(fullText, false)) {
                    try {
                        const effectiveToken = accessToken || await this._tokenStore.getValidAccessToken();
                        fullText = await autoContinueFull({
                            fullText,
                            model,
                            accessToken: effectiveToken,
                            hasTools: false,
                            maxContinue: DEFAULT_MAX_AUTO_CONTINUE,
                            systemPrompt,
                            mcpTools,
                            buildRequest: buildCursorAgentRequest,
                            createH2Stream: h2RequestStream,
                            frameMessage: frameConnectMessage,
                            processMessage: processAgentServerMessage,
                            buildHeartbeat: buildHeartbeatBytes,
                            endStreamFlag: CONNECT_END_STREAM_FLAG,
                        });
                    } catch (err) {
                        logger.warn(`[CursorApiService] Auto-continue failed: ${err.message}`);
                    }
                }

                resolved = true;
                resolve(buildResponse('stop'));
            });

            h2Stream.on('error', (err) => {
                if (resolved) return;
                clearInterval(heartbeatTimer);
                try { h2Client.close(); } catch {}
                resolved = true;
                if (fullText || thinkingText) {
                    resolve(buildResponse('stop'));
                } else {
                    reject(err);
                }
            });
        });
    }

    /**
     * Streaming H2 consumer. Yields SSE-compatible chunk objects.
     * Supports thinking tags, tool_calls with session save, and error handling.
     *
     * Used by both initial requests and session resumption.
     */
    async *_streamFromH2({ h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, model, sessionKey, systemPrompt = '', accessToken = null }) {
        const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 28)}`;
        const created = Math.floor(Date.now() / 1000);
        const makeChunk = (delta, finishReason = null) => ({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        });

        const state = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] };
        const degenerateState = {
            lastDelta: '',
            repeatCount: 0,
            tagBuffer: '',
            toolCallDepth: 0,
            toolCallHistory: [],
            aborted: false,
        };
        let mcpExecReceived = false;
        let accumulatedText = '';

        // Stream guard: warmup + tail buffering (opt-in via CURSOR_STREAM_GUARD_ENABLED)
        const guard = CURSOR_STREAM_GUARD_ENABLED
            ? createStreamGuard({ warmupChars: CURSOR_WARMUP_CHARS, guardChars: CURSOR_GUARD_CHARS })
            : null;

        // Queue+signal pattern to bridge event-driven H2 and async generator
        const queue = [];
        let done = false;
        let resolveWaiter = null;

        function enqueue(item) {
            queue.push(item);
            if (resolveWaiter) {
                const r = resolveWaiter;
                resolveWaiter = null;
                r();
            }
        }

        function waitForItem() {
            return new Promise((r) => { resolveWaiter = r; });
        }

        let pendingBuffer = Buffer.alloc(0);

        h2Stream.on('data', (incoming) => {
            pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
            while (pendingBuffer.length >= 5) {
                const flags = pendingBuffer[0];
                const msgLen = pendingBuffer.readUInt32BE(1);
                if (pendingBuffer.length < 5 + msgLen) break;
                const msgBytes = pendingBuffer.subarray(5, 5 + msgLen);
                pendingBuffer = pendingBuffer.subarray(5 + msgLen);

                if (flags & CONNECT_END_STREAM_FLAG) {
                    const errFrame = parseConnectErrorFrame(msgBytes);
                    if (errFrame) {
                        enqueue({ type: 'chunk', chunk: makeChunk({ content: `\n[Error: ${errFrame.error.message}]` }) });
                    }
                    continue;
                }

                try {
                    processAgentServerMessage(msgBytes, {
                        blobStore,
                        mcpTools,
                        sendFrame: (data) => {
                            if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(data);
                        },
                        onText: (text, isThinking) => {
                            if (degenerateState.aborted) return;
                            if (isThinking) {
                                if (!state.thinkingActive) {
                                    state.thinkingActive = true;
                                    enqueue({ type: 'chunk', chunk: makeChunk({ role: 'assistant', content: '<think>' }) });
                                }
                                enqueue({ type: 'chunk', chunk: makeChunk({ content: text }) });
                            } else {
                                if (checkDegenerateLoop(text, degenerateState, {})) {
                                    degenerateState.aborted = true;
                                    if (state.thinkingActive) {
                                        state.thinkingActive = false;
                                        enqueue({ type: 'chunk', chunk: makeChunk({ content: '</think>' }) });
                                    }
                                    enqueue({ type: 'abort_degenerate' });
                                    return;
                                }
                                if (state.thinkingActive) {
                                    state.thinkingActive = false;
                                    enqueue({ type: 'chunk', chunk: makeChunk({ content: '</think>' }) });
                                }
                                accumulatedText += text;
                                if (guard) {
                                    const toSend = guard.push(text);
                                    if (toSend) enqueue({ type: 'chunk', chunk: makeChunk({ content: toSend }) });
                                } else {
                                    enqueue({ type: 'chunk', chunk: makeChunk({ content: text }) });
                                }
                            }
                        },
                        onMcpExec: (exec) => {
                            if (degenerateState.aborted) return;
                            if (checkToolCallLoop(exec, degenerateState, {})) {
                                degenerateState.aborted = true;
                                enqueue({ type: 'abort_degenerate' });
                                return;
                            }
                            state.pendingExecs.push(exec);
                            mcpExecReceived = true;

                            if (state.thinkingActive) {
                                state.thinkingActive = false;
                                enqueue({ type: 'chunk', chunk: makeChunk({ content: '</think>' }) });
                            }
                            enqueue({ type: 'chunk', chunk: makeChunk({
                                tool_calls: [{
                                    index: state.toolCallIndex++,
                                    id: exec.toolCallId,
                                    type: 'function',
                                    function: { name: exec.toolName, arguments: exec.decodedArgs },
                                }],
                            }) });

                            // Save session so caller can resume
                            saveSession(sessionKey, {
                                h2Client,
                                h2Stream,
                                heartbeatTimer,
                                blobStore,
                                mcpTools,
                                pendingExecs: state.pendingExecs,
                            });

                            enqueue({ type: 'chunk', chunk: makeChunk({}, 'tool_calls') });
                            enqueue({ type: 'done' });
                        },
                    });
                } catch (err) {
                    logger.warn(`[CursorApiService] processAgentServerMessage error: ${err.message}`);
                }
            }
        });

        h2Stream.on('end', () => {
            clearInterval(heartbeatTimer);
            if (!mcpExecReceived) {
                try { h2Client.close(); } catch {}
                // Flush stream guard remaining buffer
                if (guard) {
                    const remaining = guard.finish();
                    if (remaining) enqueue({ type: 'chunk', chunk: makeChunk({ content: remaining }) });
                }
                if (state.thinkingActive) {
                    state.thinkingActive = false;
                    enqueue({ type: 'chunk', chunk: makeChunk({ content: '</think>' }) });
                }
                // Truncation detection: if text was collected and appears truncated, continue
                if (accumulatedText && !degenerateState.aborted && isTruncated(accumulatedText, false)) {
                    enqueue({ type: 'continue_needed' });
                } else {
                    enqueue({ type: 'chunk', chunk: makeChunk({}, 'stop') });
                }
            }
            enqueue({ type: 'done' });
        });

        h2Stream.on('error', () => {
            clearInterval(heartbeatTimer);
            if (!mcpExecReceived) {
                try { h2Client.close(); } catch {}
                enqueue({ type: 'chunk', chunk: makeChunk({}, 'stop') });
            }
            enqueue({ type: 'done' });
        });

        // Consume queue
        while (!done) {
            while (queue.length > 0) {
                const item = queue.shift();
                if (item.type === 'done') { done = true; break; }
                if (item.type === 'abort_degenerate') {
                    // Close thinking tag if still open
                    if (state.thinkingActive) {
                        state.thinkingActive = false;
                        yield makeChunk({ content: '</think>' });
                    }
                    // Emit final stop chunk and stop processing
                    yield makeChunk({}, 'stop');
                    done = true;
                    break;
                }
                if (item.type === 'continue_needed') {
                    // Auto-continue streaming: transparently yield continuation chunks
                    try {
                        const effectiveToken = accessToken || await this._tokenStore.getValidAccessToken();
                        for await (const contChunk of autoContinueStream({
                            fullText: accumulatedText,
                            model,
                            accessToken: effectiveToken,
                            hasTools: false,
                            maxContinue: DEFAULT_MAX_AUTO_CONTINUE,
                            systemPrompt,
                            mcpTools,
                            buildRequest: buildCursorAgentRequest,
                            createH2Stream: h2RequestStream,
                            frameMessage: frameConnectMessage,
                            processMessage: processAgentServerMessage,
                            buildHeartbeat: buildHeartbeatBytes,
                            endStreamFlag: CONNECT_END_STREAM_FLAG,
                        })) {
                            if (contChunk.type === 'text') {
                                yield makeChunk({ content: contChunk.text });
                            }
                        }
                    } catch (err) {
                        logger.warn(`[CursorApiService] Stream auto-continue failed: ${err.message}`);
                    }
                    // Emit the stop chunk after continuation
                    yield makeChunk({}, 'stop');
                    done = true;
                    break;
                }
                yield item.chunk;
            }
            if (!done) await waitForItem();
        }
        // Drain remaining chunks (skip abort signals)
        while (queue.length > 0) {
            const item = queue.shift();
            if (item.type === 'chunk') yield item.chunk;
        }
    }

    // ---------- Internal: model fetching ----------

    async _ensureInitialized() {
        if (!this.isInitialized) await this.initialize();
    }

    /**
     * Fetch usable models from Cursor API.
     * Returns null/[] on failure — caller uses fallback list.
     */
    async _fetchUsableModels(accessToken) {
        try {
            const requestPayload = create(GetUsableModelsRequestSchema, {});
            const body = toBinary(GetUsableModelsRequestSchema, requestPayload);

            const responseBuffer = await this._fetchModelsViaH2(body, accessToken);
            if (!responseBuffer) return null;

            const decoded = this._decodeModelsResponse(responseBuffer);
            if (!decoded) return null;

            const models = decoded.models;
            if (!Array.isArray(models) || models.length === 0) return null;

            return this._normalizeModels(models);
        } catch (err) {
            logger.warn(`[CursorApiService] _fetchUsableModels: ${err.message}`);
            return null;
        }
    }

    _fetchModelsViaH2(body, accessToken) {
        return new Promise((resolve) => {
            let settled = false;
            const settle = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(value);
            };

            const client = http2.connect(CURSOR_API_URL);

            const timeout = setTimeout(() => {
                client.destroy();
                settle(null);
            }, 5000);

            client.on('error', () => settle(null));

            const stream = client.request({
                ':method': 'POST',
                ':path': GET_USABLE_MODELS_PATH,
                'content-type': 'application/proto',
                'te': 'trailers',
                'authorization': `Bearer ${accessToken}`,
                'x-ghost-mode': 'true',
                'x-cursor-client-version': CURSOR_CLIENT_VERSION,
                'x-cursor-client-type': 'cli',
            });

            let statusOk = false;
            const chunks = [];

            stream.on('response', (headers) => {
                const status = headers[':status'];
                statusOk = typeof status === 'number' && status >= 200 && status < 300;
            });

            stream.on('data', (chunk) => chunks.push(chunk));

            stream.on('end', () => {
                try { client.close(); } catch {}
                if (!statusOk) { settle(null); return; }
                settle(new Uint8Array(Buffer.concat(chunks)));
            });

            stream.on('error', () => { try { client.close(); } catch {}; settle(null); });

            stream.write(body);
            stream.end();
        });
    }

    _decodeModelsResponse(payload) {
        if (!payload || payload.length === 0) return null;

        // Try Connect framing first (5-byte header)
        const framedBody = this._decodeConnectUnaryBody(payload);
        if (framedBody) {
            try { return fromBinary(GetUsableModelsResponseSchema, framedBody); } catch {}
        }

        // Raw protobuf
        try { return fromBinary(GetUsableModelsResponseSchema, payload); } catch {}
        return null;
    }

    _decodeConnectUnaryBody(payload) {
        if (payload.length < 5) return null;
        let offset = 0;
        while (offset + 5 <= payload.length) {
            const flags = payload[offset];
            const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
            const messageLength = view.getUint32(1, false);
            const frameEnd = offset + 5 + messageLength;
            if (frameEnd > payload.length) return null;
            if ((flags & 0b00000001) !== 0) return null; // Compression not supported
            if (!((flags & 0b00000010) !== 0)) {
                return payload.subarray(offset + 5, frameEnd);
            }
            offset = frameEnd;
        }
        return null;
    }

    _normalizeModels(models) {
        const byId = new Map();
        for (const model of models) {
            const m = model;
            const id = typeof m.modelId === 'string' ? m.modelId.trim() : '';
            if (!id) continue;
            const name = m.displayName || m.displayModelId || id;
            byId.set(id, { id, name });
        }
        return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
}
