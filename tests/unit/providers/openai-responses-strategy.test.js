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

const { ResponsesAPIStrategy } = await import('../../../src/providers/openai/openai-responses-strategy.js');

describe('ResponsesAPIStrategy', () => {
    let strategy;

    beforeEach(() => {
        strategy = new ResponsesAPIStrategy();
        mockReadFile.mockReset();
        mockWriteFile.mockReset();
    });

    describe('extractModelAndStreamInfo', () => {
        test('extracts model and stream=true', () => {
            const req = {};
            const body = { model: 'gpt-4o', stream: true };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.model).toBe('gpt-4o');
            expect(result.isStream).toBe(true);
        });

        test('returns isStream=false when stream not set', () => {
            const result = strategy.extractModelAndStreamInfo({}, { model: 'gpt-4o' });
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
                            { type: 'output_text', text: 'Responses API response' },
                        ],
                    },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('Responses API response');
        });

        test('returns empty string when output is missing', () => {
            expect(strategy.extractResponseText({})).toBe('');
        });

        test('returns empty string when output is empty array', () => {
            expect(strategy.extractResponseText({ output: [] })).toBe('');
        });

        test('skips items not of type message', () => {
            const response = {
                output: [
                    { type: 'reasoning', content: [{ type: 'output_text', text: 'ignored' }] },
                    { type: 'message', content: [{ type: 'output_text', text: 'actual' }] },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('actual');
        });

        test('skips non-output_text content items', () => {
            const response = {
                output: [
                    { type: 'message', content: [{ type: 'input_text', text: 'ignored' }] },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('');
        });
    });

    describe('extractPromptText', () => {
        test('returns string input directly', () => {
            const body = { input: 'Simple prompt' };
            expect(strategy.extractPromptText(body)).toBe('Simple prompt');
        });

        test('extracts from user role items in array input (string content)', () => {
            const body = {
                input: [
                    { role: 'system', content: 'System msg' },
                    { role: 'user', content: 'User question' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('User question');
        });

        test('extracts from user role items in array input (array content joined with newline)', () => {
            const body = {
                input: [
                    {
                        role: 'user',
                        content: [
                            { text: 'Part A' },
                            { content: 'Part B' },
                        ],
                    },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Part A\nPart B');
        });

        test('extracts from type=message with role=user', () => {
            const body = {
                input: [
                    { type: 'message', role: 'user', content: 'Type message user' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Type message user');
        });

        test('extracts from type=user items', () => {
            const body = {
                input: [{ type: 'user', content: 'User type item' }],
            };
            expect(strategy.extractPromptText(body)).toBe('User type item');
        });

        test('returns empty string when no user items in array', () => {
            const body = {
                input: [{ role: 'system', content: 'System only' }],
            };
            expect(strategy.extractPromptText(body)).toBe('');
        });

        test('returns last user item when multiple exist', () => {
            const body = {
                input: [
                    { role: 'user', content: 'First' },
                    { role: 'assistant', content: 'Reply' },
                    { role: 'user', content: 'Second' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Second');
        });

        test('returns empty string for missing input', () => {
            expect(strategy.extractPromptText({})).toBe('');
        });
    });

    describe('applySystemPromptFromFile', () => {
        test('returns unchanged body when SYSTEM_PROMPT_FILE_PATH not set', async () => {
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

        test('sets instructions field when no existing instructions', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'System instructions.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = { input: 'Do a thing' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.instructions).toBe('System instructions.');
        });

        test('in append mode with string input, converts to array with system message', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Be concise.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = { input: 'User input' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(Array.isArray(result.input)).toBe(true);
            const sysMsg = result.input.find(m => m.role === 'system');
            expect(sysMsg).toBeDefined();
            expect(sysMsg.content).toBe('Be concise.');
        });

        test('in append mode with array input, prepends system message', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Always respond clearly.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = {
                input: [{ role: 'user', content: 'Hello' }],
            };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.input[0].role).toBe('system');
            expect(result.input[0].content).toBe('Always respond clearly.');
        });

        test('updates existing system message in append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Updated rules.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = {
                input: [
                    { role: 'system', content: 'Old rules.' },
                    { role: 'user', content: 'Hello' },
                ],
            };
            const result = await strategy.applySystemPromptFromFile(config, body);
            const sysMsg = result.input.find(m => m.role === 'system');
            expect(sysMsg.content).toBe('Updated rules.');
        });

        test('initializes input as system-only array when input is undefined', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Init system.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = {};
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(Array.isArray(result.input)).toBe(true);
            expect(result.input[0].role).toBe('system');
        });
    });

    describe('manageSystemPrompt', () => {
        test('extracts instructions field as system text', async () => {
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = { instructions: 'Response API instructions.' };
            await strategy.manageSystemPrompt(body);
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.any(String),
                'Response API instructions.'
            );
        });

        test('extracts system message from input array', async () => {
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = {
                input: [
                    { role: 'system', content: 'System content.' },
                    { role: 'user', content: 'Hello' },
                ],
            };
            await strategy.manageSystemPrompt(body);
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.any(String),
                'System content.'
            );
        });

        test('handles body with type=system item in input', async () => {
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = {
                input: [
                    { type: 'system', content: 'Type system content.' },
                ],
            };
            await strategy.manageSystemPrompt(body);
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.any(String),
                'Type system content.'
            );
        });

        test('handles body with no system content', async () => {
            mockReadFile.mockResolvedValue('');
            mockWriteFile.mockResolvedValue(undefined);

            const body = { input: [{ role: 'user', content: 'Hello' }] };
            await strategy.manageSystemPrompt(body);
            expect(mockWriteFile).not.toHaveBeenCalled();
        });
    });
});
