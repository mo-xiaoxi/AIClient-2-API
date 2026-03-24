/**
 * Smoke tests for registered strategy converters (instantiation + protocol name).
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { ConverterFactory } from '../../../src/converters/ConverterFactory.js';
import { MODEL_PROTOCOL_PREFIX } from '../../../src/utils/common.js';
import '../../../src/converters/register-converters.js';

const REGISTERED = [
    MODEL_PROTOCOL_PREFIX.OPENAI,
    MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
    MODEL_PROTOCOL_PREFIX.CLAUDE,
    MODEL_PROTOCOL_PREFIX.GEMINI,
    MODEL_PROTOCOL_PREFIX.CODEX,
    MODEL_PROTOCOL_PREFIX.GROK,
];

describe('converter strategies (registered)', () => {
    beforeEach(() => {
        ConverterFactory.clearCache();
    });

    test.each(REGISTERED)('getConverter(%s) returns object with getProtocolName', (protocol) => {
        const c = ConverterFactory.getConverter(protocol);
        expect(typeof c.getProtocolName).toBe('function');
        expect(c.getProtocolName().length).toBeGreaterThan(0);
    });
});
