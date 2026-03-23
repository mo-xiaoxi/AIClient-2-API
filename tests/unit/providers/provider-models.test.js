/**
 * Unit tests for src/providers/provider-models.js
 *
 * Tests: PROVIDER_MODELS structure, DYNAMIC_MODEL_PROVIDERS,
 *        getProviderModels, getAllProviderModels.
 *
 * This module has no side-effect imports that need mocking.
 */

import { describe, test, expect } from '@jest/globals';

const {
    PROVIDER_MODELS,
    DYNAMIC_MODEL_PROVIDERS,
    getProviderModels,
    getAllProviderModels,
} = await import('../../../src/providers/provider-models.js');

// ---------------------------------------------------------------------------
// PROVIDER_MODELS structure
// ---------------------------------------------------------------------------

describe('PROVIDER_MODELS data structure', () => {
    test('is a non-null object', () => {
        expect(PROVIDER_MODELS).toBeDefined();
        expect(typeof PROVIDER_MODELS).toBe('object');
        expect(PROVIDER_MODELS).not.toBeNull();
    });

    test('contains expected provider keys', () => {
        const keys = Object.keys(PROVIDER_MODELS);
        expect(keys).toContain('gemini-cli-oauth');
        expect(keys).toContain('gemini-antigravity');
        expect(keys).toContain('claude-custom');
        expect(keys).toContain('claude-kiro-oauth');
        expect(keys).toContain('openai-custom');
        expect(keys).toContain('openai-qwen-oauth');
        expect(keys).toContain('openai-codex-oauth');
        expect(keys).toContain('forward-api');
        expect(keys).toContain('grok-custom');
        expect(keys).toContain('cursor-oauth');
    });

    test('all provider values are arrays', () => {
        for (const [key, models] of Object.entries(PROVIDER_MODELS)) {
            expect(Array.isArray(models)).toBe(true);
        }
    });

    test('gemini-cli-oauth has at least one model', () => {
        expect(PROVIDER_MODELS['gemini-cli-oauth'].length).toBeGreaterThan(0);
    });

    test('grok-custom models are all strings', () => {
        for (const model of PROVIDER_MODELS['grok-custom']) {
            expect(typeof model).toBe('string');
        }
    });

    test('openai-codex-oauth includes gpt-5 variants', () => {
        const codexModels = PROVIDER_MODELS['openai-codex-oauth'];
        expect(codexModels.some(m => m.startsWith('gpt-5'))).toBe(true);
    });

    test('claude-custom has empty array (dynamic)', () => {
        expect(PROVIDER_MODELS['claude-custom']).toEqual([]);
    });

    test('forward-api has empty array (dynamic)', () => {
        expect(PROVIDER_MODELS['forward-api']).toEqual([]);
    });

    test('cursor-oauth has empty array (dynamic)', () => {
        expect(PROVIDER_MODELS['cursor-oauth']).toEqual([]);
    });

    test('no duplicate models within a provider', () => {
        for (const [key, models] of Object.entries(PROVIDER_MODELS)) {
            const unique = new Set(models);
            expect(unique.size).toBe(models.length);
        }
    });
});

// ---------------------------------------------------------------------------
// DYNAMIC_MODEL_PROVIDERS
// ---------------------------------------------------------------------------

describe('DYNAMIC_MODEL_PROVIDERS', () => {
    test('is an array', () => {
        expect(Array.isArray(DYNAMIC_MODEL_PROVIDERS)).toBe(true);
    });

    test('contains cursor-oauth', () => {
        expect(DYNAMIC_MODEL_PROVIDERS).toContain('cursor-oauth');
    });

    test('all entries are strings', () => {
        for (const p of DYNAMIC_MODEL_PROVIDERS) {
            expect(typeof p).toBe('string');
        }
    });
});

// ---------------------------------------------------------------------------
// getProviderModels
// ---------------------------------------------------------------------------

describe('getProviderModels()', () => {
    test('returns correct models for gemini-cli-oauth', () => {
        const models = getProviderModels('gemini-cli-oauth');
        expect(Array.isArray(models)).toBe(true);
        expect(models.length).toBeGreaterThan(0);
        expect(models).toEqual(PROVIDER_MODELS['gemini-cli-oauth']);
    });

    test('returns correct models for grok-custom', () => {
        const models = getProviderModels('grok-custom');
        expect(models).toEqual(PROVIDER_MODELS['grok-custom']);
    });

    test('returns empty array for unknown provider', () => {
        const models = getProviderModels('totally-unknown-xyz');
        expect(models).toEqual([]);
    });

    test('returns empty array for claude-custom', () => {
        expect(getProviderModels('claude-custom')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// getAllProviderModels
// ---------------------------------------------------------------------------

describe('getAllProviderModels()', () => {
    test('returns the entire PROVIDER_MODELS object', () => {
        const all = getAllProviderModels();
        expect(all).toBe(PROVIDER_MODELS);
    });

    test('returned object has the same keys as PROVIDER_MODELS', () => {
        const all = getAllProviderModels();
        expect(Object.keys(all)).toEqual(Object.keys(PROVIDER_MODELS));
    });
});
