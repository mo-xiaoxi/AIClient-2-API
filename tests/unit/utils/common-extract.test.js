/**
 * extractResponseText / extractPromptText 依赖 ProviderStrategyFactory（需 mock 后再动态加载 common）
 */
import { jest, describe, test, expect, beforeAll } from '@jest/globals';

let extractResponseText;
let extractPromptText;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/provider-strategies.js', () => ({
        ProviderStrategyFactory: {
            getStrategy: jest.fn(() => ({
                extractResponseText: (response) =>
                    response?.choices?.[0]?.message?.content ?? '',
                extractPromptText: (body) => body?.messages?.[0]?.content ?? '',
            })),
        },
    }));

    await jest.unstable_mockModule('../../../src/convert/convert.js', () => ({
        convertData: jest.fn(),
        getOpenAIStreamChunkStop: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../src/core/plugin-manager.js', () => ({
        getPluginManager: jest.fn(() => ({ getPlugins: jest.fn(() => []) })),
    }));

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        default: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        },
    }));

    const mod = await import('../../../src/utils/common.js');
    extractResponseText = mod.extractResponseText;
    extractPromptText = mod.extractPromptText;
});

describe('common extractResponseText / extractPromptText (mocked strategies)', () => {
    test('extractResponseText delegates to strategy', () => {
        expect(
            extractResponseText({ choices: [{ message: { content: 'hi' } }] }, 'openai-custom')
        ).toBe('hi');
    });

    test('extractPromptText delegates to strategy', () => {
        expect(
            extractPromptText({ messages: [{ content: 'p' }] }, 'openai-custom')
        ).toBe('p');
    });
});
