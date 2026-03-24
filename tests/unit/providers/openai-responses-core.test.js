/**
 * OpenAIResponsesApiService — 构造函数与错误分支（axios 全 mock）
 */
import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const mockRequest = jest.fn();

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
        __esModule: true,
        configureAxiosProxy: jest.fn(),
        configureTLSSidecar: jest.fn((cfg) => cfg),
    }));

    await jest.unstable_mockModule('axios', () => ({
        __esModule: true,
        default: {
            create: jest.fn(() => ({ request: mockRequest })),
        },
    }));

    await jest.unstable_mockModule('http', () => ({
        __esModule: true,
        Agent: jest.fn(function Agent() {
            return {};
        }),
    }));

    await jest.unstable_mockModule('https', () => ({
        __esModule: true,
        Agent: jest.fn(function Agent() {
            return {};
        }),
    }));
});

describe('OpenAIResponsesApiService', () => {
    beforeEach(() => {
        mockRequest.mockReset();
    });

    test('constructor throws without API key', async () => {
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        expect(() => new OpenAIResponsesApiService({})).toThrow(/API Key is required/);
    });

    test('constructor sets baseUrl and creates axios instance', async () => {
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const axios = (await import('axios')).default;
        const svc = new OpenAIResponsesApiService({
            OPENAI_API_KEY: 'sk-test',
            OPENAI_BASE_URL: 'https://example.com/v1',
        });
        expect(svc.baseUrl).toBe('https://example.com/v1');
        expect(axios.create).toHaveBeenCalled();
    });

    test('callApi returns data on success', async () => {
        mockRequest.mockResolvedValueOnce({ data: { ok: true } });
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test', REQUEST_MAX_RETRIES: 0 });
        const out = await svc.callApi('/responses', { foo: 1 });
        expect(out).toEqual({ ok: true });
    });

    test('callApi propagates 401', async () => {
        const err = new Error('unauth');
        err.response = { status: 401, data: {} };
        mockRequest.mockRejectedValueOnce(err);
        const { OpenAIResponsesApiService } = await import(
            '../../../src/providers/openai/openai-responses-core.js'
        );
        const svc = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'sk-test', REQUEST_MAX_RETRIES: 0 });
        await expect(svc.callApi('/x', {})).rejects.toBe(err);
    });
});
