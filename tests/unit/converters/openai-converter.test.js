import { describe, test, expect } from '@jest/globals';
import { OpenAIConverter } from '../../../src/converters/strategies/OpenAIConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';

describe('OpenAIConverter', () => {
    const converter = new OpenAIConverter();

    test('convertRequest maps OpenAI chat to Gemini contents', () => {
        const out = converter.convertRequest(
            {
                model: 'gemini-test',
                messages: [{ role: 'user', content: 'Hello' }],
            },
            MODEL_PROTOCOL_PREFIX.GEMINI
        );
        expect(out).toHaveProperty('contents');
        expect(Array.isArray(out.contents)).toBe(true);
        expect(out.contents.length).toBeGreaterThan(0);
    });

    test('convertRequest rejects unsupported target protocol', () => {
        expect(() => converter.convertRequest({ messages: [] }, 'not-a-protocol')).toThrow(
            'Unsupported target protocol'
        );
    });
});
