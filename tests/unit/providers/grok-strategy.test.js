import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Break circular dependency through common.js → provider-strategies.js
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

const { GrokStrategy } = await import('../../../src/providers/grok/grok-strategy.js');

describe('GrokStrategy', () => {
    let strategy;

    beforeEach(() => {
        strategy = new GrokStrategy();
        mockReadFile.mockReset();
        mockWriteFile.mockReset();
    });

    describe('extractModelAndStreamInfo', () => {
        test('extracts model from requestBody', () => {
            const req = {};
            const body = { model: 'grok-3', stream: true };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.model).toBe('grok-3');
            expect(result.isStream).toBe(true);
        });

        test('defaults to grok-3 when model not specified', () => {
            const req = {};
            const body = {};
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.model).toBe('grok-3');
        });

        test('isStream defaults to true when stream is not false', () => {
            const req = {};
            const body = { model: 'grok-3' };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.isStream).toBe(true);
        });

        test('isStream is false when stream === false', () => {
            const req = {};
            const body = { model: 'grok-3', stream: false };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.isStream).toBe(false);
        });
    });

    describe('extractResponseText', () => {
        test('extracts message field from response', () => {
            const response = { message: 'Hello from Grok' };
            expect(strategy.extractResponseText(response)).toBe('Hello from Grok');
        });

        test('returns empty string when message is missing', () => {
            expect(strategy.extractResponseText({})).toBe('');
        });

        test('returns empty string for null response fields', () => {
            expect(strategy.extractResponseText({ message: '' })).toBe('');
        });
    });

    describe('extractPromptText', () => {
        test('extracts message field from requestBody', () => {
            const body = { message: 'What is AI?' };
            expect(strategy.extractPromptText(body)).toBe('What is AI?');
        });

        test('returns empty string when message is missing', () => {
            expect(strategy.extractPromptText({})).toBe('');
        });
    });

    describe('applySystemPromptFromFile', () => {
        test('returns unchanged body when SYSTEM_PROMPT_FILE_PATH is not set', async () => {
            const config = {};
            const body = { message: 'Hello' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('returns unchanged body when SYSTEM_PROMPT_CONTENT is null', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: null,
            };
            const body = { message: 'Hello' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('prepends system prompt to message in non-append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Be helpful.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = { message: 'User message.' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.message).toBe('System: Be helpful.\n\nUser message.');
        });

        test('appends system prompt in append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Also do this.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = { message: 'User message.' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.message).toBe('User message.\n\nSystem: Also do this.');
        });

        test('handles empty message in prepend mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'System prompt.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = {};
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.message).toBe('System: System prompt.\n\n');
        });
    });

    describe('manageSystemPrompt', () => {
        test('does nothing (not implemented for Grok)', async () => {
            // manageSystemPrompt is a no-op for Grok
            const body = { message: 'Hello' };
            await expect(strategy.manageSystemPrompt(body)).resolves.toBeUndefined();
        });
    });
});
