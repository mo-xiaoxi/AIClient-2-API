import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Break the circular dependency chain:
// claude-strategy.js → common.js → provider-strategies.js → claude-strategy.js
// We mock the modules that would cause the cycle.
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

// Mock fs to avoid file system access in _updateSystemPromptFile
// provider-strategy.js imports: `import { promises as fs } from 'fs'`
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

const { ClaudeStrategy } = await import('../../../src/providers/claude/claude-strategy.js');

describe('ClaudeStrategy', () => {
    let strategy;

    beforeEach(() => {
        strategy = new ClaudeStrategy();
        mockReadFile.mockReset();
        mockWriteFile.mockReset();
    });

    describe('extractModelAndStreamInfo', () => {
        test('extracts model and stream=true from requestBody', () => {
            const req = {};
            const body = { model: 'claude-3-7-sonnet-20250219', stream: true };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.model).toBe('claude-3-7-sonnet-20250219');
            expect(result.isStream).toBe(true);
        });

        test('returns isStream=false when stream is not set', () => {
            const req = {};
            const body = { model: 'claude-3-haiku' };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.isStream).toBe(false);
        });

        test('returns isStream=false when stream is false', () => {
            const req = {};
            const body = { model: 'claude-3-haiku', stream: false };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.isStream).toBe(false);
        });
    });

    describe('extractResponseText', () => {
        test('extracts text from content_block_delta with text_delta type', () => {
            const response = {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: 'Hello world' },
            };
            expect(strategy.extractResponseText(response)).toBe('Hello world');
        });

        test('extracts partial_json from content_block_delta with input_json_delta type', () => {
            const response = {
                type: 'content_block_delta',
                delta: { type: 'input_json_delta', partial_json: '{"key":' },
            };
            expect(strategy.extractResponseText(response)).toBe('{"key":');
        });

        test('returns empty string for unrecognized delta type', () => {
            const response = {
                type: 'content_block_delta',
                delta: { type: 'unknown_delta' },
            };
            expect(strategy.extractResponseText(response)).toBe('');
        });

        test('extracts text from content array with text blocks', () => {
            const response = {
                content: [
                    { type: 'text', text: 'Hello' },
                    { type: 'text', text: ' World' },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('Hello World');
        });

        test('filters out non-text blocks from content array', () => {
            const response = {
                content: [
                    { type: 'image', text: '' },
                    { type: 'text', text: 'Only text' },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('Only text');
        });

        test('extracts text from content.type===text object', () => {
            const response = {
                content: { type: 'text', text: 'Direct text' },
            };
            expect(strategy.extractResponseText(response)).toBe('Direct text');
        });

        test('returns empty string when no content', () => {
            expect(strategy.extractResponseText({})).toBe('');
        });
    });

    describe('extractPromptText', () => {
        test('extracts text from last message with content as string', () => {
            const body = {
                messages: [
                    { role: 'user', content: 'Hello' },
                    { role: 'assistant', content: 'Hi' },
                    { role: 'user', content: 'How are you?' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('How are you?');
        });

        test('extracts text from last message with content as array of blocks', () => {
            const body = {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Part A' },
                            { type: 'text', text: ' Part B' },
                        ],
                    },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Part A Part B');
        });

        test('returns empty string when no messages', () => {
            expect(strategy.extractPromptText({})).toBe('');
            expect(strategy.extractPromptText({ messages: [] })).toBe('');
        });
    });

    describe('applySystemPromptFromFile', () => {
        test('returns unchanged requestBody when SYSTEM_PROMPT_FILE_PATH is not set', async () => {
            const config = {};
            const body = { messages: [] };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('returns unchanged requestBody when SYSTEM_PROMPT_CONTENT is null', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/some/path.txt',
                SYSTEM_PROMPT_CONTENT: null,
            };
            const body = { messages: [] };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('sets system prompt in replace mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/some/path.txt',
                SYSTEM_PROMPT_CONTENT: 'You are a helpful assistant.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = {};
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.system).toBe('You are a helpful assistant.');
        });

        test('appends to existing system prompt in append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/some/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Extra instructions.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = { system: 'Original system.' };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.system).toBe('Original system.\nExtra instructions.');
        });

        test('uses file content when no existing system in append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/some/path.txt',
                SYSTEM_PROMPT_CONTENT: 'File content.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = {};
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.system).toBe('File content.');
        });
    });

    describe('manageSystemPrompt', () => {
        test('calls _updateSystemPromptFile with extracted system text', async () => {
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = { system: 'Keep this.' };
            await strategy.manageSystemPrompt(body);
            // Verify writeFile was called with the system text
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.any(String),
                'Keep this.'
            );
        });

        test('handles request body without system', async () => {
            mockReadFile.mockResolvedValue('old prompt');
            mockWriteFile.mockResolvedValue(undefined);

            const body = {};
            await strategy.manageSystemPrompt(body);
            // When incoming is empty, should clear if there was content before
            expect(mockWriteFile).toHaveBeenCalledWith(expect.any(String), '');
        });
    });
});
