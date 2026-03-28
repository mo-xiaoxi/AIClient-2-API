import { describe, test, expect, beforeEach } from '@jest/globals';
import { ConverterFactory, ContentProcessorFactory, ToolProcessorFactory } from '../../../src/converters/ConverterFactory.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';
import '../../../src/converters/register-converters.js';

describe('ConverterFactory', () => {
    beforeEach(() => {
        ConverterFactory.clearCache();
    });

    test('getRegisteredProtocols includes core protocols', () => {
        const protocols = ConverterFactory.getRegisteredProtocols();
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(protocols).toContain(MODEL_PROTOCOL_PREFIX.CLAUDE);
    });

    test('getConverter caches instances', () => {
        const a = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
        const b = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(a).toBe(b);
    });

    test('clearConverterCache drops one protocol', () => {
        const a = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
        ConverterFactory.clearConverterCache(MODEL_PROTOCOL_PREFIX.GEMINI);
        const b = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(b).not.toBe(a);
    });

    test('createConverter throws for unknown protocol', () => {
        expect(() => ConverterFactory.createConverter('__no_such_protocol__')).toThrow(
            'No converter registered for protocol'
        );
    });
});

describe('ContentProcessorFactory', () => {
    beforeEach(() => {
        ContentProcessorFactory.clearCache();
    });

    test('getProcessor returns null (not yet implemented)', () => {
        const result = ContentProcessorFactory.getProcessor('openai', 'claude');
        expect(result).toBeNull();
    });

    test('getProcessor caches result (returns same null on repeated calls)', () => {
        const a = ContentProcessorFactory.getProcessor('openai', 'claude');
        const b = ContentProcessorFactory.getProcessor('openai', 'claude');
        expect(a).toBe(b);
    });

    test('createProcessor returns null', () => {
        const result = ContentProcessorFactory.createProcessor('gemini', 'openai');
        expect(result).toBeNull();
    });

    test('clearCache resets processor state', () => {
        ContentProcessorFactory.getProcessor('openai', 'gemini');
        ContentProcessorFactory.clearCache();
        const result = ContentProcessorFactory.getProcessor('openai', 'gemini');
        expect(result).toBeNull();
    });
});

describe('ToolProcessorFactory', () => {
    beforeEach(() => {
        ToolProcessorFactory.clearCache();
    });

    test('getProcessor returns null (not yet implemented)', () => {
        const result = ToolProcessorFactory.getProcessor('openai', 'claude');
        expect(result).toBeNull();
    });

    test('createProcessor returns null', () => {
        const result = ToolProcessorFactory.createProcessor('gemini', 'openai');
        expect(result).toBeNull();
    });

    test('clearCache resets processor state', () => {
        ToolProcessorFactory.getProcessor('openai', 'gemini');
        ToolProcessorFactory.clearCache();
        const result = ToolProcessorFactory.getProcessor('openai', 'gemini');
        expect(result).toBeNull();
    });
});
