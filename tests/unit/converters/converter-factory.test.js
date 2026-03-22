import { describe, test, expect, beforeEach } from '@jest/globals';
import { ConverterFactory } from '../../../src/converters/ConverterFactory.js';
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
