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

const { OpenAIStrategy } = await import('../../../src/providers/openai/openai-strategy.js');

describe('OpenAIStrategy', () => {
    let strategy;

    beforeEach(() => {
        strategy = new OpenAIStrategy();
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
            const req = {};
            const body = { model: 'gpt-4o-mini' };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.isStream).toBe(false);
        });

        test('returns isStream=false when stream===false', () => {
            const req = {};
            const body = { model: 'gpt-4o-mini', stream: false };
            const result = strategy.extractModelAndStreamInfo(req, body);
            expect(result.isStream).toBe(false);
        });
    });

    describe('extractResponseText', () => {
        test('extracts content from message choice', () => {
            const response = {
                choices: [
                    { message: { content: 'Hello from GPT' } },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('Hello from GPT');
        });

        test('extracts content from delta choice (streaming)', () => {
            const response = {
                choices: [
                    { delta: { content: 'Streaming chunk' } },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('Streaming chunk');
        });

        test('extracts tool_calls from delta (function calling)', () => {
            const toolCalls = [{ id: 'call_1', function: { name: 'get_weather' } }];
            const response = {
                choices: [
                    { delta: { tool_calls: toolCalls } },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe(toolCalls);
        });

        test('returns empty string when choices is missing', () => {
            expect(strategy.extractResponseText({})).toBe('');
        });

        test('returns empty string when choices is empty', () => {
            expect(strategy.extractResponseText({ choices: [] })).toBe('');
        });

        test('returns empty string when choice has no content', () => {
            const response = {
                choices: [{ message: {} }],
            };
            expect(strategy.extractResponseText(response)).toBe('');
        });
    });

    describe('extractPromptText', () => {
        test('extracts string content from last message', () => {
            const body = {
                messages: [
                    { role: 'system', content: 'You are helpful.' },
                    { role: 'user', content: 'What is 2+2?' },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('What is 2+2?');
        });

        test('extracts content from array of content items (joined with newline)', () => {
            const body = {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Part A' },
                            { type: 'text', text: 'Part B' },
                        ],
                    },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Part A\nPart B');
        });

        test('stringifies object content', () => {
            const body = {
                messages: [
                    { role: 'user', content: { key: 'value' } },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('{"key":"value"}');
        });

        test('returns empty string when no messages', () => {
            expect(strategy.extractPromptText({})).toBe('');
            expect(strategy.extractPromptText({ messages: [] })).toBe('');
        });
    });

    describe('applySystemPromptFromFile', () => {
        test('returns unchanged body when SYSTEM_PROMPT_FILE_PATH is not set', async () => {
            const config = {};
            const body = { messages: [] };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('returns unchanged body when SYSTEM_PROMPT_CONTENT is null', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: null,
            };
            const body = { messages: [] };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('prepends system message when none exists (replace mode)', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'You are helpful.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = {
                messages: [{ role: 'user', content: 'Hello' }],
            };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.messages[0].role).toBe('system');
            expect(result.messages[0].content).toBe('You are helpful.');
        });

        test('replaces existing system message', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'New system.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = {
                messages: [
                    { role: 'system', content: 'Old system.' },
                    { role: 'user', content: 'Hello' },
                ],
            };
            const result = await strategy.applySystemPromptFromFile(config, body);
            const systemMsg = result.messages.find(m => m.role === 'system');
            expect(systemMsg.content).toBe('New system.');
        });

        test('appends to existing system message in append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Additional.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = {
                messages: [
                    { role: 'system', content: 'Original.' },
                    { role: 'user', content: 'Hi' },
                ],
            };
            const result = await strategy.applySystemPromptFromFile(config, body);
            const systemMsg = result.messages.find(m => m.role === 'system');
            expect(systemMsg.content).toBe('Original.\nAdditional.');
        });

        test('initializes messages array if missing', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'System.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = {};
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.messages).toBeDefined();
            expect(result.messages[0].role).toBe('system');
        });
    });

    describe('manageSystemPrompt', () => {
        test('calls _updateSystemPromptFile with extracted system text', async () => {
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = {
                messages: [
                    { role: 'system', content: 'OpenAI system.' },
                    { role: 'user', content: 'Hello' },
                ],
            };
            await strategy.manageSystemPrompt(body);
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.any(String),
                'OpenAI system.'
            );
        });

        test('uses user message content as fallback when no system message', async () => {
            // When no system message exists, openai extracts user message as fallback
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = { messages: [{ role: 'user', content: 'Hello' }] };
            await strategy.manageSystemPrompt(body);
            // Falls back to user message content as system text
            expect(mockWriteFile).toHaveBeenCalledWith(expect.any(String), 'Hello');
        });
    });
});
