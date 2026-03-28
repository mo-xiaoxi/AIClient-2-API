import { parseSuffix, processThinkingSuffix } from '../../../src/utils/thinking-config.js';

describe('thinking-config', () => {
    describe('parseSuffix', () => {
        it('should return no suffix for plain model names', () => {
            expect(parseSuffix('gpt-5.2')).toEqual({
                modelName: 'gpt-5.2',
                hasSuffix: false,
                rawSuffix: '',
            });
        });

        it('should parse numeric suffix', () => {
            expect(parseSuffix('claude-sonnet-4-5(16384)')).toEqual({
                modelName: 'claude-sonnet-4-5',
                hasSuffix: true,
                rawSuffix: '16384',
            });
        });

        it('should parse level suffix', () => {
            expect(parseSuffix('gpt-5.2(high)')).toEqual({
                modelName: 'gpt-5.2',
                hasSuffix: true,
                rawSuffix: 'high',
            });
        });

        it('should parse none suffix', () => {
            expect(parseSuffix('gemini-2.5-pro(none)')).toEqual({
                modelName: 'gemini-2.5-pro',
                hasSuffix: true,
                rawSuffix: 'none',
            });
        });

        it('should handle unmatched parentheses gracefully', () => {
            expect(parseSuffix('model(partial')).toEqual({
                modelName: 'model(partial',
                hasSuffix: false,
                rawSuffix: '',
            });
        });

        it('should handle empty/null input', () => {
            expect(parseSuffix('')).toEqual({ modelName: '', hasSuffix: false, rawSuffix: '' });
            expect(parseSuffix(null)).toEqual({ modelName: '', hasSuffix: false, rawSuffix: '' });
        });

        it('should use last opening parenthesis', () => {
            expect(parseSuffix('model(v2)(high)')).toEqual({
                modelName: 'model(v2)',
                hasSuffix: true,
                rawSuffix: 'high',
            });
        });
    });

    describe('processThinkingSuffix', () => {
        it('should return unchanged model when no suffix present', () => {
            const body = { model: 'gpt-5.2', messages: [] };
            const result = processThinkingSuffix('gpt-5.2', body, 'openai');
            expect(result.model).toBe('gpt-5.2');
            expect(result.applied).toBe(false);
        });

        it('should apply reasoning_effort for OpenAI protocol with level suffix', () => {
            const body = { model: 'gpt-5.2(high)', messages: [] };
            const result = processThinkingSuffix('gpt-5.2(high)', body, 'openai');
            expect(result.model).toBe('gpt-5.2');
            expect(result.applied).toBe(true);
            expect(body.reasoning_effort).toBe('high');
        });

        it('should apply reasoning_effort for OpenAI protocol with low level', () => {
            const body = { model: 'gpt-5(low)', messages: [] };
            const result = processThinkingSuffix('gpt-5(low)', body, 'openai');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(true);
            expect(body.reasoning_effort).toBe('low');
        });

        it('should apply budget to Claude protocol', () => {
            const body = { model: 'claude-sonnet-4-5(16384)', messages: [] };
            const result = processThinkingSuffix('claude-sonnet-4-5(16384)', body, 'claude');
            expect(result.model).toBe('claude-sonnet-4-5');
            expect(result.applied).toBe(true);
            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
        });

        it('should apply adaptive thinking for Claude with level suffix', () => {
            const body = { model: 'claude-opus-4-6(high)', messages: [] };
            const result = processThinkingSuffix('claude-opus-4-6(high)', body, 'claude');
            expect(result.model).toBe('claude-opus-4-6');
            expect(result.applied).toBe(true);
            expect(body.thinking).toEqual({ type: 'adaptive', effort: 'high' });
        });

        it('should disable thinking with none suffix', () => {
            const body = { model: 'gpt-5(none)', messages: [], reasoning_effort: 'high' };
            const result = processThinkingSuffix('gpt-5(none)', body, 'openai');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(true);
            expect(body.reasoning_effort).toBeUndefined();
        });

        it('should apply Gemini thinkingConfig with budget suffix', () => {
            const body = { model: 'gemini-2.5-pro(8192)' };
            const result = processThinkingSuffix('gemini-2.5-pro(8192)', body, 'gemini');
            expect(result.model).toBe('gemini-2.5-pro');
            expect(result.applied).toBe(true);
            expect(body.generationConfig.thinkingConfig).toEqual({
                thinkingBudget: 8192,
                includeThoughts: true,
            });
        });

        it('should apply auto thinking', () => {
            const body = { model: 'gpt-5(auto)', messages: [] };
            const result = processThinkingSuffix('gpt-5(auto)', body, 'openai');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(true);
            expect(body.reasoning_effort).toBe('high');
        });

        it('should handle Codex protocol', () => {
            const body = { model: 'gpt-5(medium)' };
            const result = processThinkingSuffix('gpt-5(medium)', body, 'codex');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(true);
            expect(body.reasoning).toEqual({ effort: 'medium' });
        });

        it('should not apply for unknown suffix format', () => {
            const body = { model: 'gpt-5(unknown_value)', messages: [] };
            const result = processThinkingSuffix('gpt-5(unknown_value)', body, 'openai');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(false);
        });

        it('should handle budget conversion to OpenAI reasoning_effort', () => {
            const body = { model: 'gpt-5(32768)', messages: [] };
            const result = processThinkingSuffix('gpt-5(32768)', body, 'openai');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(true);
            expect(body.reasoning_effort).toBe('high');
        });

        // --- Suffix "0" → NONE mode ---
        it('should handle suffix "0" as NONE mode (budget of zero)', () => {
            const body = { model: 'gpt-5(0)', messages: [], reasoning_effort: 'high' };
            const result = processThinkingSuffix('gpt-5(0)', body, 'openai');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(true);
            expect(body.reasoning_effort).toBeUndefined();
        });

        // --- Grok protocol ---
        it('should apply OpenAI format for grok protocol', () => {
            const body = { model: 'grok-3(high)', messages: [] };
            const result = processThinkingSuffix('grok-3(high)', body, 'grok');
            expect(result.model).toBe('grok-3');
            expect(result.applied).toBe(true);
            expect(body.reasoning_effort).toBe('high');
        });

        // --- Unknown protocol defaults to OpenAI format ---
        it('should default to OpenAI format for unknown protocol', () => {
            const body = { model: 'model-x(medium)', messages: [] };
            const result = processThinkingSuffix('model-x(medium)', body, 'unknown-protocol');
            expect(result.model).toBe('model-x');
            expect(result.applied).toBe(true);
            expect(body.reasoning_effort).toBe('medium');
        });

        // --- Claude NONE and AUTO ---
        it('should delete thinking from body for Claude NONE mode', () => {
            const body = { model: 'claude-opus(none)', thinking: { type: 'enabled' } };
            const result = processThinkingSuffix('claude-opus(none)', body, 'claude');
            expect(result.model).toBe('claude-opus');
            expect(result.applied).toBe(true);
            expect(body.thinking).toBeUndefined();
        });

        it('should apply auto thinking for Claude AUTO mode', () => {
            const body = { model: 'claude-opus(auto)', messages: [] };
            const result = processThinkingSuffix('claude-opus(auto)', body, 'claude');
            expect(result.model).toBe('claude-opus');
            expect(result.applied).toBe(true);
            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: -1 });
        });

        // --- Claude LEVEL with non-adaptive levels (xhigh/minimal) ---
        it('should convert xhigh level to budget for Claude (not adaptive)', () => {
            const body = { model: 'claude-sonnet(xhigh)', messages: [] };
            const result = processThinkingSuffix('claude-sonnet(xhigh)', body, 'claude');
            expect(result.model).toBe('claude-sonnet');
            expect(result.applied).toBe(true);
            expect(body.thinking.type).toBe('enabled');
            expect(body.thinking.budget_tokens).toBeGreaterThan(0);
        });

        // --- Gemini NONE, AUTO, LEVEL ---
        it('should delete Gemini thinkingConfig for NONE mode', () => {
            const body = {
                model: 'gemini-2.5(none)',
                generationConfig: { thinkingConfig: { thinkingBudget: 8192 } },
            };
            const result = processThinkingSuffix('gemini-2.5(none)', body, 'gemini');
            expect(result.model).toBe('gemini-2.5');
            expect(result.applied).toBe(true);
            expect(body.generationConfig.thinkingConfig).toBeUndefined();
        });

        it('should apply auto thinking for Gemini AUTO mode', () => {
            const body = { model: 'gemini-2.5(auto)' };
            const result = processThinkingSuffix('gemini-2.5(auto)', body, 'gemini');
            expect(result.model).toBe('gemini-2.5');
            expect(result.applied).toBe(true);
            expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
        });

        it('should apply thinkingBudget for Gemini LEVEL mode', () => {
            const body = { model: 'gemini-2.5(high)' };
            const result = processThinkingSuffix('gemini-2.5(high)', body, 'gemini');
            expect(result.model).toBe('gemini-2.5');
            expect(result.applied).toBe(true);
            expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
        });

        // --- Codex NONE, AUTO, BUDGET ---
        it('should delete reasoning from body for Codex NONE mode', () => {
            const body = { model: 'gpt-5(none)', reasoning: { effort: 'high' } };
            const result = processThinkingSuffix('gpt-5(none)', body, 'codex');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(true);
            expect(body.reasoning).toBeUndefined();
        });

        it('should apply auto thinking for Codex AUTO mode', () => {
            const body = { model: 'gpt-5(auto)' };
            const result = processThinkingSuffix('gpt-5(auto)', body, 'codex');
            expect(result.model).toBe('gpt-5');
            expect(result.applied).toBe(true);
            expect(body.reasoning).toEqual({ effort: 'high' });
        });

        it('should map Codex budget ≤4096 to low effort', () => {
            const body = { model: 'gpt-5(2048)' };
            const result = processThinkingSuffix('gpt-5(2048)', body, 'codex');
            expect(result.applied).toBe(true);
            expect(body.reasoning.effort).toBe('low');
        });

        it('should map Codex budget ≤16384 to medium effort', () => {
            const body = { model: 'gpt-5(8192)' };
            const result = processThinkingSuffix('gpt-5(8192)', body, 'codex');
            expect(result.applied).toBe(true);
            expect(body.reasoning.effort).toBe('medium');
        });

        it('should map Codex budget >16384 to high effort', () => {
            const body = { model: 'gpt-5(32768)' };
            const result = processThinkingSuffix('gpt-5(32768)', body, 'codex');
            expect(result.applied).toBe(true);
            expect(body.reasoning.effort).toBe('high');
        });
    });
});
