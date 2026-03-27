/**
 * cursor-tool-fixer.js
 *
 * Tool argument auto-repair for Cursor provider.
 * Fixes common formatting issues in AI-generated tool call arguments:
 * 1. Smart quote replacement (Unicode → ASCII)
 * 2. Fuzzy matching for str_replace/search_replace tools
 *
 * Ported from cursor2api tool-fixer.ts.
 */

import { readFileSync, existsSync } from 'node:fs';

const SMART_DOUBLE_QUOTES = new Set([
    '\u00ab', '\u201c', '\u201d', '\u275e',
    '\u201f', '\u201e', '\u275d', '\u00bb',
]);

const SMART_SINGLE_QUOTES = new Set([
    '\u2018', '\u2019', '\u201a', '\u201b',
]);

/**
 * Replace smart/curly quotes with ASCII quotes.
 * @param {string} text
 * @returns {string}
 */
export function replaceSmartQuotes(text) {
    if (!text) return text;
    const chars = [...text];
    return chars.map(ch => {
        if (SMART_DOUBLE_QUOTES.has(ch)) return '"';
        if (SMART_SINGLE_QUOTES.has(ch)) return "'";
        return ch;
    }).join('');
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFuzzyPattern(text) {
    const parts = [];
    for (const ch of text) {
        if (SMART_DOUBLE_QUOTES.has(ch) || ch === '"') {
            parts.push('["\u00ab\u201c\u201d\u275e\u201f\u201e\u275d\u00bb]');
        } else if (SMART_SINGLE_QUOTES.has(ch) || ch === "'") {
            parts.push("['\u2018\u2019\u201a\u201b]");
        } else if (ch === ' ' || ch === '\t') {
            parts.push('\\s+');
        } else if (ch === '\\') {
            parts.push('\\\\{1,2}');
        } else {
            parts.push(escapeRegExp(ch));
        }
    }
    return parts.join('');
}

/**
 * Repair str_replace/search_replace tool's old_string by fuzzy matching.
 * @param {string} toolName
 * @param {object} args
 * @returns {object}
 */
export function repairExactMatchToolArguments(toolName, args) {
    if (!args || typeof args !== 'object') return args;

    const lowerName = (toolName || '').toLowerCase();
    if (!lowerName.includes('str_replace') && !lowerName.includes('search_replace') && !lowerName.includes('strreplace')) {
        return args;
    }

    const oldString = args.old_string ?? args.old_str;
    if (!oldString) return args;

    const filePath = args.path ?? args.file_path;
    if (!filePath) return args;

    try {
        if (!existsSync(filePath)) return args;
        const content = readFileSync(filePath, 'utf-8');

        // Already matches exactly — no repair needed
        if (content.includes(oldString)) return args;

        const pattern = buildFuzzyPattern(oldString);
        const regex = new RegExp(pattern, 'g');
        const matches = [...content.matchAll(regex)];

        // Only repair if there's exactly one match (unique)
        if (matches.length !== 1) return args;

        const matchedText = matches[0][0];

        if ('old_string' in args) args.old_string = matchedText;
        else if ('old_str' in args) args.old_str = matchedText;

        // Also fix smart quotes in new_string
        const newString = args.new_string ?? args.new_str;
        if (newString) {
            const fixed = replaceSmartQuotes(newString);
            if ('new_string' in args) args.new_string = fixed;
            else if ('new_str' in args) args.new_str = fixed;
        }
    } catch {
        // best-effort: file read failure doesn't block the request
    }

    return args;
}

/**
 * Apply all fixes to tool call arguments.
 * @param {string} toolName
 * @param {object} args
 * @returns {object}
 */
export function fixToolCallArguments(toolName, args) {
    if (!args || typeof args !== 'object') return args;

    // Apply smart quote replacement to all string values
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string') {
            args[key] = replaceSmartQuotes(value);
        }
    }

    // Repair exact match for str_replace tools
    args = repairExactMatchToolArguments(toolName, args);

    return args;
}
