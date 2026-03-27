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
    });
});
