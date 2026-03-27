/**
 * thinking-config.js
 *
 * Per-model thinking configuration via model name suffix.
 *
 * Users can append a thinking configuration suffix to the model name:
 *   - model-name(high)     → reasoning_effort: "high"
 *   - model-name(16384)    → budget_tokens: 16384
 *   - model-name(none)     → disable thinking
 *   - model-name(auto)     → automatic thinking
 *
 * The suffix is parsed and stripped from the model name, then applied
 * to the request body in the appropriate format for the target provider.
 *
 * Ported from CLIProxyAPIPlus internal/thinking/ (Go).
 */

import logger from './logger.js';

// ============================================================================
// Types / Constants
// ============================================================================

/** @enum {string} */
const ThinkingMode = {
    BUDGET: 'budget',
    LEVEL: 'level',
    NONE: 'none',
    AUTO: 'auto',
};

const VALID_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Budget defaults when converting from level to numeric budget
const LEVEL_TO_BUDGET = {
    minimal: 1024,
    low: 4096,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
    max: 65536,
};

// ============================================================================
// Suffix Parsing
// ============================================================================

/**
 * Parse a thinking suffix from a model name.
 *
 * Format: model-name(value) where value is a level name or numeric budget.
 *
 * @param {string} model - Full model name, possibly with suffix
 * @returns {{ modelName: string, hasSuffix: boolean, rawSuffix: string }}
 *
 * @example
 * parseSuffix('claude-sonnet-4-5(16384)')
 * // → { modelName: 'claude-sonnet-4-5', hasSuffix: true, rawSuffix: '16384' }
 *
 * parseSuffix('gpt-5.2(high)')
 * // → { modelName: 'gpt-5.2', hasSuffix: true, rawSuffix: 'high' }
 *
 * parseSuffix('gemini-2.5-pro')
 * // → { modelName: 'gemini-2.5-pro', hasSuffix: false, rawSuffix: '' }
 */
export function parseSuffix(model) {
    if (!model || typeof model !== 'string') {
        return { modelName: model || '', hasSuffix: false, rawSuffix: '' };
    }

    const lastOpen = model.lastIndexOf('(');
    if (lastOpen === -1 || !model.endsWith(')')) {
        return { modelName: model, hasSuffix: false, rawSuffix: '' };
    }

    const modelName = model.slice(0, lastOpen);
    const rawSuffix = model.slice(lastOpen + 1, -1);

    return { modelName, hasSuffix: true, rawSuffix };
}

/**
 * Parse a raw suffix string into a ThinkingConfig object.
 *
 * Priority:
 *   1. Special values: "none" → NONE, "auto"/"-1" → AUTO
 *   2. Level names: "low", "medium", "high", etc. → LEVEL
 *   3. Numeric values: positive integers → BUDGET, 0 → NONE
 *
 * @param {string} rawSuffix
 * @returns {{ mode: string, budget: number, level: string }|null}
 */
function parseSuffixToConfig(rawSuffix) {
    if (!rawSuffix) return null;

    const lower = rawSuffix.toLowerCase().trim();

    // 1. Special values
    if (lower === 'none') {
        return { mode: ThinkingMode.NONE, budget: 0, level: '' };
    }
    if (lower === 'auto' || lower === '-1') {
        return { mode: ThinkingMode.AUTO, budget: -1, level: '' };
    }

    // 2. Level names
    if (VALID_LEVELS.has(lower)) {
        return { mode: ThinkingMode.LEVEL, budget: 0, level: lower };
    }

    // 3. Numeric budget
    const num = parseInt(rawSuffix, 10);
    if (Number.isFinite(num) && num >= 0 && String(num) === rawSuffix.trim()) {
        if (num === 0) {
            return { mode: ThinkingMode.NONE, budget: 0, level: '' };
        }
        return { mode: ThinkingMode.BUDGET, budget: num, level: '' };
    }

    // Unknown suffix
    return null;
}

// ============================================================================
// Apply Thinking Config to Request Body
// ============================================================================

/**
 * Apply a thinking configuration to the request body based on target provider protocol.
 *
 * @param {object} requestBody - The request body (mutated in place)
 * @param {{ mode: string, budget: number, level: string }} config - Parsed thinking config
 * @param {string} targetProtocol - Target protocol prefix: 'openai', 'claude', 'gemini', 'codex', 'grok'
 */
function applyThinkingToBody(requestBody, config, targetProtocol) {
    if (!config || !requestBody) return;

    switch (targetProtocol) {
        case 'openai':
            applyOpenAI(requestBody, config);
            break;
        case 'claude':
            applyClaude(requestBody, config);
            break;
        case 'gemini':
            applyGemini(requestBody, config);
            break;
        case 'codex':
            applyCodex(requestBody, config);
            break;
        case 'grok':
            applyOpenAI(requestBody, config); // Grok uses OpenAI format
            break;
        default:
            // For unknown protocols, try OpenAI format as default
            applyOpenAI(requestBody, config);
            break;
    }
}

/**
 * Apply thinking config in OpenAI format (reasoning_effort field).
 */
function applyOpenAI(body, config) {
    switch (config.mode) {
        case ThinkingMode.NONE:
            delete body.reasoning_effort;
            break;
        case ThinkingMode.AUTO:
            body.reasoning_effort = 'high';
            break;
        case ThinkingMode.LEVEL:
            // OpenAI supports: low, medium, high
            body.reasoning_effort = config.level;
            break;
        case ThinkingMode.BUDGET:
            // Convert budget to reasoning_effort level
            if (config.budget <= 4096) body.reasoning_effort = 'low';
            else if (config.budget <= 16384) body.reasoning_effort = 'medium';
            else body.reasoning_effort = 'high';
            break;
    }
}

/**
 * Apply thinking config in Claude format (thinking object).
 */
function applyClaude(body, config) {
    switch (config.mode) {
        case ThinkingMode.NONE:
            delete body.thinking;
            break;
        case ThinkingMode.AUTO:
            body.thinking = { type: 'enabled', budget_tokens: -1 };
            break;
        case ThinkingMode.LEVEL:
            // Claude 4.6+ supports adaptive thinking with effort levels
            if (['low', 'medium', 'high', 'max'].includes(config.level)) {
                body.thinking = { type: 'adaptive', effort: config.level };
            } else {
                // Convert other levels to budget
                const budget = LEVEL_TO_BUDGET[config.level] || 8192;
                body.thinking = { type: 'enabled', budget_tokens: budget };
            }
            break;
        case ThinkingMode.BUDGET:
            body.thinking = { type: 'enabled', budget_tokens: config.budget };
            break;
    }
}

/**
 * Apply thinking config in Gemini format (generationConfig.thinkingConfig).
 */
function applyGemini(body, config) {
    switch (config.mode) {
        case ThinkingMode.NONE:
            if (body.generationConfig?.thinkingConfig) {
                delete body.generationConfig.thinkingConfig;
            }
            break;
        case ThinkingMode.AUTO:
            body.generationConfig = body.generationConfig || {};
            body.generationConfig.thinkingConfig = { includeThoughts: true };
            break;
        case ThinkingMode.LEVEL: {
            body.generationConfig = body.generationConfig || {};
            // Gemini 3 uses thinkingLevel, Gemini 2.5 uses thinkingBudget
            // Default to thinkingBudget for broader compatibility
            const budget = LEVEL_TO_BUDGET[config.level] || 8192;
            body.generationConfig.thinkingConfig = {
                thinkingBudget: budget,
                includeThoughts: true,
            };
            break;
        }
        case ThinkingMode.BUDGET:
            body.generationConfig = body.generationConfig || {};
            body.generationConfig.thinkingConfig = {
                thinkingBudget: config.budget,
                includeThoughts: true,
            };
            break;
    }
}

/**
 * Apply thinking config in Codex/OpenAI Responses format (reasoning.effort).
 */
function applyCodex(body, config) {
    switch (config.mode) {
        case ThinkingMode.NONE:
            delete body.reasoning;
            break;
        case ThinkingMode.AUTO:
            body.reasoning = { effort: 'high' };
            break;
        case ThinkingMode.LEVEL:
            body.reasoning = { effort: config.level };
            break;
        case ThinkingMode.BUDGET:
            if (config.budget <= 4096) body.reasoning = { effort: 'low' };
            else if (config.budget <= 16384) body.reasoning = { effort: 'medium' };
            else body.reasoning = { effort: 'high' };
            break;
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Process a model name for thinking suffix and apply thinking configuration
 * to the request body if a suffix is found.
 *
 * This is the main entry point. Call it early in the request pipeline,
 * before protocol conversion.
 *
 * @param {string} model - The model name, possibly with thinking suffix
 * @param {object} requestBody - The request body (may be mutated)
 * @param {string} fromProtocol - Source protocol prefix (e.g., 'openai', 'claude')
 * @returns {{ model: string, applied: boolean }}
 *   - model: The clean model name without suffix
 *   - applied: Whether a thinking config was applied
 */
export function processThinkingSuffix(model, requestBody, fromProtocol) {
    const { modelName, hasSuffix, rawSuffix } = parseSuffix(model);

    if (!hasSuffix) {
        return { model, applied: false };
    }

    const config = parseSuffixToConfig(rawSuffix);
    if (!config) {
        logger.warn(`[Thinking] Unknown suffix format: "${rawSuffix}" in model "${model}", ignoring`);
        return { model: modelName, applied: false };
    }

    logger.info(`[Thinking] Model suffix detected: "${model}" → model="${modelName}", ${config.mode}=${config.level || config.budget}`);

    // Apply thinking config to the request body in the source protocol format
    // (the converter will handle cross-protocol translation later)
    applyThinkingToBody(requestBody, config, fromProtocol);

    return { model: modelName, applied: true };
}

export { ThinkingMode, VALID_LEVELS, LEVEL_TO_BUDGET };
