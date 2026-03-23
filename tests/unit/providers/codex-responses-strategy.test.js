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

const { CodexResponsesAPIStrategy } = await import('../../../src/providers/openai/codex-responses-strategy.js');

describe('CodexResponsesAPIStrategy', () => {
    let strategy;

    beforeEach(() => {
        strategy = new CodexResponsesAPIStrategy();
        mockReadFile.mockReset();
        mockWriteFile.mockReset();
    });

    describe('extractModelAndStreamInfo', () => {
        test('extracts model and stream from requestBody', () => {
            const req = {};
            const body = { model: 'gpt-5-codex-mini', stream: true };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.model).toBe('gpt-5-codex-mini');
            expect(result.isStream).toBe(true);
        });

        test('returns isStream=false when stream is not set', () => {
            const result = strategy.extractModelAndStreamInfo({}, { model: 'codex-mini' });
            expect(result.isStream).toBe(false);
        });
    });

    describe('extractResponseText', () => {
        test('extracts text from output array with output_text content', () => {
            const response = {
                output: [
                    {
                        type: 'message',
                        content: [
                            { type: 'output_text', text: 'Codex response' },
                        ],
                    },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('Codex response');
        });

        test('returns empty string when output is missing', () => {
            expect(strategy.extractResponseText({})).toBe('');
        });

        test('returns empty string when output is empty', () => {
            expect(strategy.extractResponseText({ output: [] })).toBe('');
        });

        test('returns empty string when item type is not message', () => {
            const response = {
                output: [
                    { type: 'function_call', content: [{ type: 'output_text', text: 'ignored' }] },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('');
        });

        test('returns empty string when content has no output_text', () => {
            const response = {
                output: [
                    { type: 'message', content: [{ type: 'input_text', text: 'ignored' }] },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('');
        });

        test('returns empty string when content is empty', () => {
            const response = { output: [{ type: 'message', content: [] }] };
            expect(strategy.extractResponseText(response)).toBe('');
        });
    });

    describe('extractPromptText', () => {
        test('returns string input directly', () => {
            const body = { input: 'Simple string prompt' };
            expect(strategy.extractPromptText(body)).toBe('Simple string prompt');
        });

        test('extracts from array input with role=user items (string content)', () => {
            const body = {
                input: [
                    { role: 'developer', content: 'System instruction' },
                    { role: 'user', content: 'User question' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('User question');
        });

        test('extracts from array input with role=user items (array content joined with newline)', () => {
            const body = {
                input: [
                    {
                        role: 'user',
                        content: [
                            { text: 'Part A' },
                            { text: 'Part B' },
                        ],
                    },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Part A\nPart B');
        });

        test('extracts from type=message with role=user', () => {
            const body = {
                input: [
                    { type: 'message', role: 'user', content: 'Hello' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Hello');
        });

        test('extracts from type=user items', () => {
            const body = {
                input: [
                    { type: 'user', content: 'Direct user type' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Direct user type');
        });

        test('returns empty string when no user items in array input', () => {
            const body = {
                input: [
                    { role: 'developer', content: 'Only developer' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('');
        });

        test('returns empty string for missing input', () => {
            expect(strategy.extractPromptText({})).toBe('');
        });
    });

    describe('applySystemPromptFromFile', () => {
        test('returns unchanged body when SYSTEM_PROMPT_FILE_PATH is not set', async () => {
            const config = {};
            const body = { input: 'Hello' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('returns unchanged body when SYSTEM_PROMPT_CONTENT is null', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: null,
            };
            const body = { input: 'Hello' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('sets instructions field when not in append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Codex developer instruction.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = { input: 'Write code' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            // instructions gets set since there's no existing instructions
            expect(result.instructions).toBe('Codex developer instruction.');
        });

        test('in append mode with string input converts to array format', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Extra rules.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = { input: 'User says hello' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(Array.isArray(result.input)).toBe(true);
            const devMsg = result.input.find(m => m.role === 'developer');
            expect(devMsg).toBeDefined();
            expect(devMsg.content).toBe('Extra rules.');
        });

        test('in append mode with array input prepends developer message', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Be concise.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = {
                input: [{ role: 'user', content: 'Hello' }],
            };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.input[0].role).toBe('developer');
            expect(result.input[0].content).toBe('Be concise.');
        });

        test('updates existing developer message in append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'New instructions.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = {
                input: [
                    { role: 'developer', content: 'Old instructions.' },
                    { role: 'user', content: 'Hello' },
                ],
            };
            const result = await strategy.applySystemPromptFromFile(config, body);
            const devMsg = result.input.find(m => m.role === 'developer');
            expect(devMsg.content).toBe('New instructions.');
        });
    });

    describe('manageSystemPrompt', () => {
        test('extracts instructions field as system text', async () => {
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = { instructions: 'Codex instructions.' };
            await strategy.manageSystemPrompt(body);
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.any(String),
                'Codex instructions.'
            );
        });

        test('extracts developer message from input array', async () => {
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = {
                input: [
                    { role: 'developer', content: 'Dev content.' },
                    { role: 'user', content: 'Hello' },
                ],
            };
            await strategy.manageSystemPrompt(body);
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.any(String),
                'Dev content.'
            );
        });

        test('handles body with neither instructions nor developer in input', async () => {
            mockReadFile.mockResolvedValue('');
            mockWriteFile.mockResolvedValue(undefined);

            const body = { input: [{ role: 'user', content: 'Hello' }] };
            await strategy.manageSystemPrompt(body);
            // No write needed since incoming is empty and file is also empty
            expect(mockWriteFile).not.toHaveBeenCalled();
        });
    });
});
