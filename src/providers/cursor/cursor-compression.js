/**
 * cursor-compression.js
 *
 * History message compression for Cursor provider.
 * Compresses OpenAI-format message arrays to reduce token usage
 * before sending to Cursor API.
 */

import logger from '../../utils/logger.js';

// Compression level parameter table (ported from cursor2api converter.ts)
export const COMPRESSION_LEVEL_PARAMS = {
    1: { keepRecent: 10, maxChars: 4000, briefLen: 500 },
    2: { keepRecent: 6, maxChars: 2000, briefLen: 300 },
    3: { keepRecent: 4, maxChars: 1000, briefLen: 150 },
};

/**
 * Estimate token count for a messages array (chars / 4 heuristic).
 * @param {Array} messages - OpenAI format messages
 * @returns {number}
 */
export function estimateMessageTokens(messages) {
    let totalChars = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            totalChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) totalChars += part.text.length;
            }
        }
        if (msg.tool_calls) {
            totalChars += JSON.stringify(msg.tool_calls).length;
        }
    }
    return Math.ceil(totalChars / 4);
}

/**
 * Compress a single message based on level parameters.
 * @param {object} msg - OpenAI format message
 * @param {object} params - { maxChars, briefLen }
 * @returns {object} compressed message
 */
function compressMessage(msg, params) {
    // Tool call message (assistant with tool_calls)
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolNames = msg.tool_calls.map(tc => tc.function?.name || 'unknown').join(', ');
        const totalChars = JSON.stringify(msg.tool_calls).length;
        const compressed = { ...msg, content: `[Executed: ${toolNames}] (${totalChars} chars compressed)` };
        delete compressed.tool_calls;
        return compressed;
    }

    // Tool result message (role='tool')
    if (msg.role === 'tool') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (content.length <= params.maxChars) return msg;
        const head = content.slice(0, params.briefLen);
        const tail = content.slice(-params.briefLen);
        const omitted = content.length - params.briefLen * 2;
        return {
            ...msg,
            content: `${head}\n[...${omitted} chars omitted...]\n${tail}`,
        };
    }

    // Plain text message
    const content = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content)
            ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('')
            : '';
    if (content.length <= params.maxChars) return msg;

    const truncated = content.slice(0, params.maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > params.maxChars * 0.8 ? lastNewline : params.maxChars;
    return {
        ...msg,
        content: content.slice(0, cutPoint) + '\n[...truncated...]',
    };
}

/**
 * Compress OpenAI messages array. Only compresses when total tokens exceed threshold.
 * Recent messages are preserved intact.
 *
 * @param {Array} messages - OpenAI format messages
 * @param {object} [options]
 * @param {number} [options.level=2] - Compression level 1/2/3
 * @param {number} [options.keepRecent] - Override keep recent count
 * @param {number} [options.maxHistoryTokens=120000] - Token threshold to trigger compression
 * @returns {Array} compressed messages
 */
export function compressMessages(messages, options = {}) {
    const {
        level = 2,
        keepRecent = undefined,
        maxHistoryTokens = 120_000,
    } = options;

    const params = COMPRESSION_LEVEL_PARAMS[level] || COMPRESSION_LEVEL_PARAMS[2];
    const effectiveKeepRecent = keepRecent ?? params.keepRecent;

    const totalTokens = estimateMessageTokens(messages);
    if (totalTokens <= maxHistoryTokens) return messages;

    logger.debug(`[CursorCompression] Total tokens: ${totalTokens}, threshold: ${maxHistoryTokens}, compressing...`);

    const recentStart = Math.max(0, messages.length - effectiveKeepRecent);
    const toCompress = messages.slice(0, recentStart);
    const recent = messages.slice(recentStart);

    const compressed = toCompress.map(msg => compressMessage(msg, params));

    const savedChars = JSON.stringify(toCompress).length - JSON.stringify(compressed).length;
    logger.debug(`[CursorCompression] Compressed ${toCompress.length} messages, saved ~${savedChars} chars`);

    return [...compressed, ...recent];
}
