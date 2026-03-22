import { describe, test, expect } from '@jest/globals';
import { normalizeConfiguredProviders } from '../../../src/core/config-manager.js';
import { MODEL_PROVIDER } from '../../../src/utils/common.js';

describe('normalizeConfiguredProviders', () => {
    test('dedupes and normalizes case for known providers', () => {
        const cfg = { MODEL_PROVIDER: 'OpenAI-Custom' };
        normalizeConfiguredProviders(cfg);
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.OPENAI_CUSTOM);
        expect(cfg.DEFAULT_MODEL_PROVIDERS).toEqual([MODEL_PROVIDER.OPENAI_CUSTOM]);
    });

    test('supports comma-separated string', () => {
        const cfg = { MODEL_PROVIDER: 'gemini-cli-oauth, openai-custom' };
        normalizeConfiguredProviders(cfg);
        expect(cfg.DEFAULT_MODEL_PROVIDERS).toEqual([
            MODEL_PROVIDER.GEMINI_CLI,
            MODEL_PROVIDER.OPENAI_CUSTOM,
        ]);
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.GEMINI_CLI);
    });

    test('falls back to gemini when unknown only', () => {
        const cfg = { MODEL_PROVIDER: 'totally-unknown-provider' };
        normalizeConfiguredProviders(cfg);
        expect(cfg.MODEL_PROVIDER).toBe(MODEL_PROVIDER.GEMINI_CLI);
        expect(cfg.DEFAULT_MODEL_PROVIDERS).toEqual([MODEL_PROVIDER.GEMINI_CLI]);
    });

    test('array input dedupes', () => {
        const cfg = { MODEL_PROVIDER: ['openai-custom', 'openai-custom', 'claude-custom'] };
        normalizeConfiguredProviders(cfg);
        expect(cfg.DEFAULT_MODEL_PROVIDERS).toEqual([
            MODEL_PROVIDER.OPENAI_CUSTOM,
            MODEL_PROVIDER.CLAUDE_CUSTOM,
        ]);
    });
});
