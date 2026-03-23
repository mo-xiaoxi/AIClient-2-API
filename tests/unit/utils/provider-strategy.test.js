/**
 * provider-strategy.js 单元测试
 * 测试: ProviderStrategy 抽象基类
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let ProviderStrategy;
let mockFsReadFile;
let mockFsWriteFile;

beforeAll(async () => {
    mockFsReadFile = jest.fn();
    mockFsWriteFile = jest.fn();

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/utils/common.js', () => ({
        __esModule: true,
        FETCH_SYSTEM_PROMPT_FILE: '/tmp/test-system-prompt.txt',
    }));

    await jest.unstable_mockModule('fs', () => ({
        __esModule: true,
        promises: {
            readFile: mockFsReadFile,
            writeFile: mockFsWriteFile,
        },
    }));

    const mod = await import('../../../src/utils/provider-strategy.js');
    ProviderStrategy = mod.ProviderStrategy;
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('ProviderStrategy 抽象方法', () => {
    let strategy;

    beforeEach(() => {
        strategy = new ProviderStrategy();
    });

    test('extractModelAndStreamInfo 应抛出未实现错误', () => {
        expect(() => strategy.extractModelAndStreamInfo({}, {})).toThrow('must be implemented');
    });

    test('extractResponseText 应抛出未实现错误', () => {
        expect(() => strategy.extractResponseText({})).toThrow('must be implemented');
    });

    test('extractPromptText 应抛出未实现错误', () => {
        expect(() => strategy.extractPromptText({})).toThrow('must be implemented');
    });

    test('applySystemPromptFromFile 应抛出未实现错误', async () => {
        await expect(strategy.applySystemPromptFromFile({}, {})).rejects.toThrow('must be implemented');
    });

    test('manageSystemPrompt 应抛出未实现错误', async () => {
        await expect(strategy.manageSystemPrompt({})).rejects.toThrow('must be implemented');
    });
});

describe('_updateSystemPromptFile', () => {
    let strategy;

    beforeEach(() => {
        strategy = new ProviderStrategy();
    });

    test('新的 system prompt 应写入文件', async () => {
        mockFsReadFile.mockResolvedValue('old prompt');
        mockFsWriteFile.mockResolvedValue(undefined);

        await strategy._updateSystemPromptFile('new prompt', 'test-provider');

        expect(mockFsWriteFile).toHaveBeenCalledWith('/tmp/test-system-prompt.txt', 'new prompt');
    });

    test('相同的 system prompt 不应写入文件', async () => {
        mockFsReadFile.mockResolvedValue('same prompt');
        mockFsWriteFile.mockResolvedValue(undefined);

        await strategy._updateSystemPromptFile('same prompt', 'test-provider');

        expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    test('空的 system prompt 且文件有内容时应清空', async () => {
        mockFsReadFile.mockResolvedValue('existing content');
        mockFsWriteFile.mockResolvedValue(undefined);

        await strategy._updateSystemPromptFile('', 'test-provider');

        expect(mockFsWriteFile).toHaveBeenCalledWith('/tmp/test-system-prompt.txt', '');
    });

    test('空的 system prompt 且文件也为空时不写入', async () => {
        mockFsReadFile.mockResolvedValue('');
        mockFsWriteFile.mockResolvedValue(undefined);

        await strategy._updateSystemPromptFile('', 'test-provider');

        expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    test('文件不存在时应处理 ENOENT 错误', async () => {
        const enoentError = new Error('ENOENT');
        enoentError.code = 'ENOENT';
        mockFsReadFile.mockRejectedValue(enoentError);
        mockFsWriteFile.mockResolvedValue(undefined);

        await strategy._updateSystemPromptFile('new content', 'test-provider');

        expect(mockFsWriteFile).toHaveBeenCalledWith('/tmp/test-system-prompt.txt', 'new content');
    });

    test('读取文件时非 ENOENT 错误应记录日志但不阻塞', async () => {
        const otherError = new Error('Permission denied');
        otherError.code = 'EACCES';
        mockFsReadFile.mockRejectedValue(otherError);
        mockFsWriteFile.mockResolvedValue(undefined);

        // 不应抛出错误
        await strategy._updateSystemPromptFile('new content', 'test-provider');
    });

    test('写入文件失败时应记录日志但不抛出', async () => {
        mockFsReadFile.mockResolvedValue('old');
        mockFsWriteFile.mockRejectedValue(new Error('Disk full'));

        // 不应抛出错误
        await strategy._updateSystemPromptFile('new content', 'test-provider');
    });

    test('null system prompt 且文件有内容时应清空', async () => {
        mockFsReadFile.mockResolvedValue('existing');
        mockFsWriteFile.mockResolvedValue(undefined);

        await strategy._updateSystemPromptFile(null, 'test-provider');

        // null 是 falsy，currentSystemText 有内容 → 执行清空分支
        expect(mockFsWriteFile).toHaveBeenCalledWith('/tmp/test-system-prompt.txt', '');
    });
});
