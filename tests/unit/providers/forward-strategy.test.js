/**
 * ForwardStrategy — 纯逻辑；需 mock provider-strategies 打破 common 循环依赖
 */
import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let ForwardStrategy;

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/provider-strategies.js', () => ({
        ProviderStrategyFactory: { getStrategy: jest.fn() },
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

    await jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
        default: {},
        getTlsSidecarProcess: jest.fn(),
    }));

    const mockReadFile = jest.fn();
    const mockWriteFile = jest.fn();
    await jest.unstable_mockModule('fs', () => ({
        default: {
            promises: { readFile: mockReadFile, writeFile: mockWriteFile },
            existsSync: jest.fn(() => false),
        },
        promises: { readFile: mockReadFile, writeFile: mockWriteFile },
        existsSync: jest.fn(() => false),
    }));

    const mod = await import('../../../src/providers/forward/forward-strategy.js');
    ForwardStrategy = mod.ForwardStrategy;
});

describe('ForwardStrategy', () => {
    let strategy;

    beforeEach(() => {
        strategy = new ForwardStrategy();
    });

    test('extractModelAndStreamInfo: default model and stream flag', () => {
        expect(strategy.extractModelAndStreamInfo({}, {})).toEqual({ model: 'default', isStream: false });
        expect(strategy.extractModelAndStreamInfo({}, { model: 'm', stream: true })).toEqual({
            model: 'm',
            isStream: true,
        });
    });

    test('extractResponseText: OpenAI message / delta / Claude content array', () => {
        expect(
            strategy.extractResponseText({
                choices: [{ message: { content: 'a' } }],
            })
        ).toBe('a');
        expect(
            strategy.extractResponseText({
                choices: [{ delta: { content: 'b' } }],
            })
        ).toBe('b');
        expect(
            strategy.extractResponseText({
                content: [{ text: 'x' }, { text: 'y' }],
            })
        ).toBe('xy');
        expect(strategy.extractResponseText({})).toBe('');
    });

    test('extractPromptText: last message string or object', () => {
        expect(
            strategy.extractPromptText({
                messages: [{ role: 'user', content: 'hi' }],
            })
        ).toBe('hi');
        expect(
            strategy.extractPromptText({
                messages: [{ role: 'user', content: { x: 1 } }],
            })
        ).toBe('{"x":1}');
        expect(strategy.extractPromptText({})).toBe('');
    });

    test('applySystemPromptFromFile returns body unchanged', async () => {
        const b = { x: 1 };
        await expect(strategy.applySystemPromptFromFile({}, b)).resolves.toBe(b);
    });

    test('manageSystemPrompt resolves', async () => {
        await expect(strategy.manageSystemPrompt({})).resolves.toBeUndefined();
    });
});
