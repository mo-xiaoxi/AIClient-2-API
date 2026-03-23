import { describe, test, expect, beforeEach } from '@jest/globals';
import { ConverterFactory } from '../../../src/converters/ConverterFactory.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';

// Import side-effect: runs registerAllConverters()
import '../../../src/converters/register-converters.js';

// Import converter classes to verify they are instances of the correct type
import { OpenAIConverter } from '../../../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../../../src/converters/strategies/OpenAIResponsesConverter.js';
import { ClaudeConverter } from '../../../src/converters/strategies/ClaudeConverter.js';
import { GeminiConverter } from '../../../src/converters/strategies/GeminiConverter.js';
import { CodexConverter } from '../../../src/converters/strategies/CodexConverter.js';
import { GrokConverter } from '../../../src/converters/strategies/GrokConverter.js';

describe('register-converters', () => {
    beforeEach(() => {
        // Clear instance cache between tests so we test fresh instances
        ConverterFactory.clearCache();
    });

    test('OPENAI protocol is registered', () => {
        const protocols = ConverterFactory.getRegisteredProtocols();
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.OPENAI);
    });

    test('OPENAI_RESPONSES protocol is registered', () => {
        const protocols = ConverterFactory.getRegisteredProtocols();
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
    });

    test('CLAUDE protocol is registered', () => {
        const protocols = ConverterFactory.getRegisteredProtocols();
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.CLAUDE);
    });

    test('GEMINI protocol is registered', () => {
        const protocols = ConverterFactory.getRegisteredProtocols();
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.GEMINI);
    });

    test('CODEX protocol is registered', () => {
        const protocols = ConverterFactory.getRegisteredProtocols();
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.CODEX);
    });

    test('GROK protocol is registered', () => {
        const protocols = ConverterFactory.getRegisteredProtocols();
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.GROK);
    });

    test('getConverter(OPENAI) returns OpenAIConverter instance', () => {
        const conv = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(conv).toBeInstanceOf(OpenAIConverter);
    });

    test('getConverter(OPENAI_RESPONSES) returns OpenAIResponsesConverter instance', () => {
        const conv = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(conv).toBeInstanceOf(OpenAIResponsesConverter);
    });

    test('getConverter(CLAUDE) returns ClaudeConverter instance', () => {
        const conv = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(conv).toBeInstanceOf(ClaudeConverter);
    });

    test('getConverter(GEMINI) returns GeminiConverter instance', () => {
        const conv = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(conv).toBeInstanceOf(GeminiConverter);
    });

    test('getConverter(CODEX) returns CodexConverter instance', () => {
        const conv = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CODEX);
        expect(conv).toBeInstanceOf(CodexConverter);
    });

    test('getConverter(GROK) returns GrokConverter instance', () => {
        const conv = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GROK);
        expect(conv).toBeInstanceOf(GrokConverter);
    });

    test('all registered protocols are recognised by isProtocolRegistered', () => {
        const expected = [
            MODEL_PROTOCOL_PREFIX.OPENAI,
            MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
            MODEL_PROTOCOL_PREFIX.CLAUDE,
            MODEL_PROTOCOL_PREFIX.GEMINI,
            MODEL_PROTOCOL_PREFIX.CODEX,
            MODEL_PROTOCOL_PREFIX.GROK,
        ];
        expected.forEach(proto => {
            expect(ConverterFactory.isProtocolRegistered(proto)).toBe(true);
        });
    });

    test('exactly 6 converter protocols are registered', () => {
        const protocols = ConverterFactory.getRegisteredProtocols();
        expect(protocols.length).toBeGreaterThanOrEqual(6);
    });
});
