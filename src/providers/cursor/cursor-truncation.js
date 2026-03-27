/**
 * cursor-truncation.js
 *
 * Truncation detection and automatic continuation for Cursor API responses.
 * Ported from cursor2api handler.ts and adapted for this codebase.
 *
 * All public functions are pure / side-effect-free except autoContinueFull
 * and autoContinueStream, which accept injected dependencies for testability.
 */

import logger from '../../utils/logger.js';

// ============================================================================
// Truncation detection
// ============================================================================

/**
 * Detect whether a response text appears to be truncated mid-output.
 *
 * Five heuristics (in order):
 *  1. JSON action block unclosed (tool-call mode only)
 *  2. Code fence (```) count is odd
 *  3. More line-start open XML tags than close tags (by more than 1)
 *  4. Text ends with a syntax-incomplete character (,;:[{()
 *  5. Long response (>2000 chars) ending with \n and not a closing code fence
 *
 * @param {string|null|undefined} text
 * @param {boolean} [hasTools=false]
 * @returns {boolean}
 */
export function isTruncated(text, hasTools = false) {
    if (!text || text.trim().length === 0) return false;
    const trimmed = text.trimEnd();

    // 1. Tool call: json action block unclosed
    if (hasTools) {
        const actionOpens = (trimmed.match(/```json\s+action/g) || []).length;
        if (actionOpens > 0) {
            const actionBlocks = (trimmed.match(/```json\s+action[\s\S]*?```/g) || []).length;
            return actionOpens > actionBlocks;
        }
    }

    // 2. Code block unclosed (line-start ``` count)
    const lineStartFences = (trimmed.match(/^```/gm) || []).length;
    if (lineStartFences % 2 !== 0) return true;

    // 3. XML/HTML tag mismatch
    const openTags = (trimmed.match(/^<[a-zA-Z]/gm) || []).length;
    const closeTags = (trimmed.match(/^<\/[a-zA-Z]/gm) || []).length;
    if (openTags > closeTags + 1) return true;

    // 4. Syntactically incomplete ending
    if (/[,;:\[{(]\s*$/.test(trimmed)) return true;

    // 5. Long response ending with actual newline (mid-stream truncation).
    //    We check the original (un-trimmed) text here so trailing \n is visible.
    //    Also exclude responses that end with a properly closed code fence.
    if (text.length > 2000 && /\n\s*$/.test(text) && !trimmed.endsWith('```')) return true;

    return false;
}

// ============================================================================
// Deduplication
// ============================================================================

/**
 * Deduplicate the junction between an existing text and a continuation.
 *
 * Strategy:
 *  1. Character-level overlap: find the longest suffix of `existing` that
 *     matches a prefix of `continuation` (max window: 500 chars).
 *  2. Line-level overlap fallback: compare lines.
 *
 * Returns only the non-overlapping portion of `continuation`.
 *
 * @param {string} existing
 * @param {string} continuation
 * @returns {string}
 */
export function deduplicateContinuation(existing, continuation) {
    if (!existing) return continuation || '';
    if (!continuation) return '';

    // --- 1. Character-level overlap ---
    const maxWindow = Math.min(500, existing.length, continuation.length);
    for (let len = maxWindow; len >= 1; len--) {
        const tail = existing.slice(existing.length - len);
        if (continuation.startsWith(tail)) {
            return continuation.slice(len);
        }
    }

    // --- 2. Line-level overlap fallback ---
    const existingLines = existing.split('\n');
    const continuationLines = continuation.split('\n');

    // Find the longest suffix of existingLines that matches a prefix of continuationLines
    const maxLineWindow = Math.min(existingLines.length, continuationLines.length);
    for (let len = maxLineWindow; len >= 1; len--) {
        const existingTail = existingLines.slice(existingLines.length - len);
        const continuationHead = continuationLines.slice(0, len);
        if (existingTail.join('\n') === continuationHead.join('\n')) {
            return continuationLines.slice(len).join('\n');
        }
    }

    // No overlap found — return continuation as-is
    return continuation;
}

// ============================================================================
// Thinking tag repair
// ============================================================================

/**
 * If `text` contains an unclosed `<think>` (or `<thinking>`) tag, append
 * the matching closing tag.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function closeUnclosedThinking(text) {
    if (!text) return '';

    const openThink = (text.match(/<think>/g) || []).length;
    const closeThink = (text.match(/<\/think>/g) || []).length;

    if (openThink > closeThink) {
        return text + '</think>';
    }

    return text;
}

// ============================================================================
// Continuation prompt builder
// ============================================================================

/**
 * Build a continuation prompt that instructs the model to resume from the
 * cut-off point without repeating any already-generated content.
 *
 * The prompt includes an anchor consisting of the last 300 characters of
 * `fullText` so the model can orient itself.
 *
 * @param {string} fullText - The (truncated) text generated so far.
 * @returns {string}
 */
export function buildContinuationPrompt(fullText) {
    const anchor = fullText.length > 300 ? fullText.slice(-300) : fullText;
    return (
        'Your previous response was cut off mid-output. The last part of your output was:\n\n' +
        '```\n' +
        `...${anchor}\n` +
        '```\n\n' +
        'Continue EXACTLY from where you stopped. DO NOT repeat any content already generated. ' +
        'DO NOT restart the response. Output ONLY the remaining content, starting immediately from the cut-off point.'
    );
}

// ============================================================================
// Internal: collect a full continuation response from a new H2 stream
// ============================================================================

/**
 * @private
 * Launch a new H2 request and collect all text into a single string.
 *
 * @param {object} params
 * @param {Buffer|Uint8Array} params.requestBytes
 * @param {Map}              params.blobStore
 * @param {Array}            params.mcpTools
 * @param {string}           params.accessToken
 * @param {Function}         params.createH2Stream   - h2RequestStream
 * @param {Function}         params.frameMessage      - frameConnectMessage
 * @param {Function}         params.processMessage    - processAgentServerMessage
 * @param {Function}         params.buildHeartbeat    - buildHeartbeatBytes
 * @param {number}           params.endStreamFlag     - CONNECT_END_STREAM_FLAG
 * @returns {Promise<string>}
 */
async function _collectContinuation({
    requestBytes,
    blobStore,
    mcpTools,
    accessToken,
    createH2Stream,
    frameMessage,
    processMessage,
    buildHeartbeat,
    endStreamFlag,
}) {
    return new Promise((resolve) => {
        let text = '';
        let pendingBuffer = Buffer.alloc(0);
        let settled = false;

        const settle = (value) => {
            if (settled) return;
            settled = true;
            clearInterval(heartbeatTimer);
            try { h2Client.close(); } catch {}
            resolve(value);
        };

        const { client: h2Client, stream: h2Stream } = createH2Stream({ accessToken });
        h2Stream.write(frameMessage(requestBytes));

        const heartbeatTimer = setInterval(() => {
            if (!h2Stream.closed && !h2Stream.destroyed) {
                h2Stream.write(buildHeartbeat());
            }
        }, 5_000);

        h2Stream.on('data', (incoming) => {
            if (settled) return;
            pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
            while (pendingBuffer.length >= 5) {
                const flags = pendingBuffer[0];
                const msgLen = pendingBuffer.readUInt32BE(1);
                if (pendingBuffer.length < 5 + msgLen) break;
                const msgBytes = pendingBuffer.subarray(5, 5 + msgLen);
                pendingBuffer = pendingBuffer.subarray(5 + msgLen);

                if (flags & endStreamFlag) {
                    // End-stream frame — check for error, then ignore
                    try {
                        const payload = JSON.parse(msgBytes.toString('utf8'));
                        if (payload?.error) {
                            logger.warn(`[CursorTruncation] Continuation stream error: ${payload.error.message}`);
                        }
                    } catch {}
                    continue;
                }

                try {
                    processMessage(msgBytes, {
                        blobStore,
                        mcpTools,
                        sendFrame: () => {}, // ignore tool calls during continuation
                        onText: (chunk, isThinking) => {
                            if (!isThinking) text += chunk;
                        },
                        onMcpExec: () => {}, // ignore tool calls during continuation
                    });
                } catch (err) {
                    logger.warn(`[CursorTruncation] processMessage error: ${err.message}`);
                }
            }
        });

        h2Stream.on('end', () => settle(text));
        h2Stream.on('error', (err) => {
            logger.warn(`[CursorTruncation] H2 stream error during continuation: ${err.message}`);
            settle(text);
        });
    });
}

// ============================================================================
// Non-streaming auto-continuation
// ============================================================================

/**
 * Attempt up to `maxContinue` rounds of continuation for a truncated response.
 * Each round sends a new H2 request with the accumulated text as context,
 * collects the continuation, deduplicates, and appends.
 *
 * All H2/Protobuf dependencies are injected for testability.
 *
 * @param {object} params
 * @param {string}   params.fullText          - The (possibly truncated) text so far.
 * @param {string}   params.model             - Model ID.
 * @param {string}   params.accessToken       - Bearer token.
 * @param {boolean}  [params.hasTools=false]  - Whether tool calls are active.
 * @param {number}   [params.maxContinue=3]   - Maximum continuation rounds.
 * @param {string}   [params.systemPrompt=''] - System prompt for continuation requests.
 * @param {Array}    [params.mcpTools=[]]     - MCP tool definitions.
 * @param {Function} params.buildRequest      - buildCursorAgentRequest
 * @param {Function} params.createH2Stream    - h2RequestStream
 * @param {Function} params.frameMessage      - frameConnectMessage
 * @param {Function} params.processMessage    - processAgentServerMessage
 * @param {Function} params.buildHeartbeat    - buildHeartbeatBytes
 * @param {number}   params.endStreamFlag     - CONNECT_END_STREAM_FLAG
 * @returns {Promise<string>}
 */
export async function autoContinueFull({
    fullText,
    model,
    accessToken,
    hasTools = false,
    maxContinue = 3,
    systemPrompt = '',
    mcpTools = [],
    buildRequest,
    createH2Stream,
    frameMessage,
    processMessage,
    buildHeartbeat,
    endStreamFlag,
}) {
    let result = fullText;
    let continueCount = 0;

    while (isTruncated(result, hasTools) && continueCount < maxContinue) {
        continueCount++;
        logger.info(`[CursorTruncation] Truncation detected, continuation ${continueCount}/${maxContinue}`);

        const prompt = buildContinuationPrompt(result);
        const assistantContext = closeUnclosedThinking(
            result.length > 2000 ? '...\n' + result.slice(-2000) : result
        );

        let requestBytes, blobStore;
        try {
            ({ requestBytes, blobStore } = buildRequest({
                modelId: model,
                systemPrompt: systemPrompt || '',
                userText: prompt,
                images: [],
                turns: [{ userText: '', assistantText: assistantContext }],
                mcpTools: mcpTools || [],
            }));
        } catch (err) {
            logger.warn(`[CursorTruncation] buildRequest failed: ${err.message}`);
            break;
        }

        const continuationText = await _collectContinuation({
            requestBytes,
            blobStore,
            mcpTools: mcpTools || [],
            accessToken,
            createH2Stream,
            frameMessage,
            processMessage,
            buildHeartbeat,
            endStreamFlag,
        });

        if (!continuationText || continuationText.trim().length === 0) {
            logger.info('[CursorTruncation] Empty continuation received, stopping');
            break;
        }

        const deduped = deduplicateContinuation(result, continuationText);
        if (!deduped || deduped.trim().length === 0) {
            logger.info('[CursorTruncation] Continuation fully overlaps existing text, stopping');
            break;
        }

        logger.info(`[CursorTruncation] Continuation ${continueCount}: added ${deduped.length} chars`);
        result += deduped;
    }

    if (continueCount >= maxContinue && isTruncated(result, hasTools)) {
        logger.warn(`[CursorTruncation] Max continuations reached (${maxContinue}), returning partial response`);
    }

    return result;
}

// ============================================================================
// Streaming auto-continuation
// ============================================================================

/**
 * Streaming variant of autoContinueFull.
 *
 * Yields text chunks to the caller (as { type: 'text', text } objects) and
 * handles multiple continuation rounds transparently. The caller never sees
 * intermediate "finish" signals between rounds.
 *
 * @param {object} params - Same parameters as autoContinueFull.
 * @yields {{ type: 'text', text: string }}
 */
export async function* autoContinueStream({
    fullText,
    model,
    accessToken,
    hasTools = false,
    maxContinue = 3,
    systemPrompt = '',
    mcpTools = [],
    buildRequest,
    createH2Stream,
    frameMessage,
    processMessage,
    buildHeartbeat,
    endStreamFlag,
}) {
    let accumulatedText = fullText;
    let continueCount = 0;

    while (isTruncated(accumulatedText, hasTools) && continueCount < maxContinue) {
        continueCount++;
        logger.info(`[CursorTruncation] Stream continuation ${continueCount}/${maxContinue}`);

        const prompt = buildContinuationPrompt(accumulatedText);
        const assistantContext = closeUnclosedThinking(
            accumulatedText.length > 2000 ? '...\n' + accumulatedText.slice(-2000) : accumulatedText
        );

        let requestBytes, blobStore;
        try {
            ({ requestBytes, blobStore } = buildRequest({
                modelId: model,
                systemPrompt: systemPrompt || '',
                userText: prompt,
                images: [],
                turns: [{ userText: '', assistantText: assistantContext }],
                mcpTools: mcpTools || [],
            }));
        } catch (err) {
            logger.warn(`[CursorTruncation] buildRequest failed: ${err.message}`);
            return;
        }

        // Stream the continuation chunks
        let continuationText = '';

        yield* (async function* () {
            const { client: h2Client, stream: h2Stream } = createH2Stream({ accessToken });
            h2Stream.write(frameMessage(requestBytes));

            const heartbeatTimer = setInterval(() => {
                if (!h2Stream.closed && !h2Stream.destroyed) {
                    h2Stream.write(buildHeartbeat());
                }
            }, 5_000);

            const queue = [];
            let done = false;
            let resolveWaiter = null;
            let pendingBuffer = Buffer.alloc(0);

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

            h2Stream.on('data', (incoming) => {
                if (done) return;
                pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
                while (pendingBuffer.length >= 5) {
                    const flags = pendingBuffer[0];
                    const msgLen = pendingBuffer.readUInt32BE(1);
                    if (pendingBuffer.length < 5 + msgLen) break;
                    const msgBytes = pendingBuffer.subarray(5, 5 + msgLen);
                    pendingBuffer = pendingBuffer.subarray(5 + msgLen);

                    if (flags & endStreamFlag) {
                        try {
                            const payload = JSON.parse(msgBytes.toString('utf8'));
                            if (payload?.error) {
                                logger.warn(`[CursorTruncation] Stream continuation error: ${payload.error.message}`);
                            }
                        } catch {}
                        continue;
                    }

                    try {
                        processMessage(msgBytes, {
                            blobStore,
                            mcpTools: mcpTools || [],
                            sendFrame: () => {},
                            onText: (chunk, isThinking) => {
                                if (!isThinking) {
                                    enqueue({ type: 'text', text: chunk });
                                }
                            },
                            onMcpExec: () => {},
                        });
                    } catch (err) {
                        logger.warn(`[CursorTruncation] processMessage error: ${err.message}`);
                    }
                }
            });

            h2Stream.on('end', () => {
                clearInterval(heartbeatTimer);
                try { h2Client.close(); } catch {}
                enqueue({ type: 'done' });
            });

            h2Stream.on('error', (err) => {
                logger.warn(`[CursorTruncation] H2 stream error during stream continuation: ${err.message}`);
                clearInterval(heartbeatTimer);
                try { h2Client.close(); } catch {}
                enqueue({ type: 'done' });
            });

            while (!done) {
                while (queue.length > 0) {
                    const item = queue.shift();
                    if (item.type === 'done') {
                        done = true;
                        break;
                    }
                    continuationText += item.text;
                    yield item;
                }
                if (!done) await waitForItem();
            }
            // Drain remaining
            while (queue.length > 0) {
                const item = queue.shift();
                if (item.type === 'text') {
                    continuationText += item.text;
                    yield item;
                }
            }
        })();

        if (!continuationText || continuationText.trim().length === 0) {
            logger.info('[CursorTruncation] Empty stream continuation, stopping');
            break;
        }

        const deduped = deduplicateContinuation(accumulatedText, continuationText);
        if (!deduped || deduped.trim().length === 0) {
            logger.info('[CursorTruncation] Stream continuation fully overlaps, stopping');
            break;
        }

        accumulatedText += deduped;
    }

    if (continueCount >= maxContinue && isTruncated(accumulatedText, hasTools)) {
        logger.warn(`[CursorTruncation] Max stream continuations reached (${maxContinue}), partial response returned`);
    }
}
