import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Break circular dependency: gemini-strategy.js → common.js → provider-strategies.js → gemini-strategy.js
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

const { GeminiStrategy } = await import('../../../src/providers/gemini/gemini-strategy.js');

describe('GeminiStrategy', () => {
    let strategy;

    beforeEach(() => {
        strategy = new GeminiStrategy();
        mockReadFile.mockReset();
        mockWriteFile.mockReset();
    });

    describe('extractModelAndStreamInfo', () => {
        test('extracts model and detects generateContent action', () => {
            const req = {
                url: '/v1beta/models/gemini-2.0-flash:generateContent',
                headers: { host: 'localhost:3000' },
            };
            const result = strategy.extractModelAndStreamInfo(req, {});
            expect(result.model).toBe('gemini-2.0-flash');
            expect(result.isStream).toBe(false);
        });

        test('extracts model and detects streamGenerateContent action', () => {
            const req = {
                url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
                headers: { host: 'localhost:3000' },
            };
            const result = strategy.extractModelAndStreamInfo(req, {});
            expect(result.model).toBe('gemini-2.5-flash');
            expect(result.isStream).toBe(true);
        });

        test('handles model names with colons in path', () => {
            const req = {
                url: '/v1beta/models/gemini-pro:generateContent',
                headers: { host: 'api.example.com' },
            };
            const result = strategy.extractModelAndStreamInfo(req, {});
            expect(result.model).toBe('gemini-pro');
            expect(result.isStream).toBe(false);
        });
    });

    describe('extractResponseText', () => {
        test('extracts text from candidates array', () => {
            const response = {
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'Hello' }, { text: ' World' }],
                        },
                    },
                ],
            };
            expect(strategy.extractResponseText(response)).toBe('Hello World');
        });

        test('returns empty string when candidates is empty', () => {
            expect(strategy.extractResponseText({ candidates: [] })).toBe('');
        });

        test('returns empty string when no parts', () => {
            const response = {
                candidates: [{ content: { parts: [] } }],
            };
            expect(strategy.extractResponseText(response)).toBe('');
        });

        test('returns empty string when no content', () => {
            const response = { candidates: [{}] };
            expect(strategy.extractResponseText(response)).toBe('');
        });

        test('returns empty string when response has no candidates', () => {
            expect(strategy.extractResponseText({})).toBe('');
        });
    });

    describe('extractPromptText', () => {
        test('extracts text from last content entry parts', () => {
            const body = {
                contents: [
                    { parts: [{ text: 'First' }] },
                    { parts: [{ text: 'Second' }, { text: ' part' }] },
                ],
            };
            expect(strategy.extractPromptText(body)).toBe('Second part');
        });

        test('returns empty string when no contents', () => {
            expect(strategy.extractPromptText({})).toBe('');
            expect(strategy.extractPromptText({ contents: [] })).toBe('');
        });

        test('returns empty string when parts is empty', () => {
            const body = { contents: [{ parts: [] }] };
            expect(strategy.extractPromptText(body)).toBe('');
        });
    });

    describe('applySystemPromptFromFile', () => {
        test('returns unchanged body when SYSTEM_PROMPT_FILE_PATH is not set', async () => {
            const config = {};
            const body = { contents: [] };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('returns unchanged body when SYSTEM_PROMPT_CONTENT is null', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: null,
            };
            const body = { contents: [] };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result).toBe(body);
        });

        test('sets systemInstruction in replace mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'You are Gemini.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = {};
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.systemInstruction).toEqual({ parts: [{ text: 'You are Gemini.' }] });
        });

        test('appends to existing systemInstruction in append mode', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'Extra.',
                SYSTEM_PROMPT_MODE: 'append',
            };
            const body = { systemInstruction: { parts: [{ text: 'Original.' }] } };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.systemInstruction.parts[0].text).toBe('Original.\nExtra.');
        });

        test('removes system_instruction (snake_case) if present', async () => {
            const config = {
                SYSTEM_PROMPT_FILE_PATH: '/path.txt',
                SYSTEM_PROMPT_CONTENT: 'New prompt.',
                SYSTEM_PROMPT_MODE: 'replace',
            };
            const body = { system_instruction: { parts: [{ text: 'Old.' }] } };
            const result = await strategy.applySystemPromptFromFile(config, body);
            expect(result.system_instruction).toBeUndefined();
            expect(result.systemInstruction).toBeDefined();
        });
    });

    describe('manageSystemPrompt', () => {
        test('calls _updateSystemPromptFile with extracted system text', async () => {
            mockReadFile.mockRejectedValue({ code: 'ENOENT' });
            mockWriteFile.mockResolvedValue(undefined);

            const body = {
                systemInstruction: { parts: [{ text: 'Gemini system.' }] },
            };
            await strategy.manageSystemPrompt(body);
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.any(String),
                'Gemini system.'
            );
        });
    });
});
