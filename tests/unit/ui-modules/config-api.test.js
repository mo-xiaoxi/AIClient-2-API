/**
 * UI Module: config-api.js Tests
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
    default: {},
    initTlsSidecar: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.unstable_mockModule('../../../src/core/config-manager.js', () => ({
    CONFIG: { MODEL_PROVIDER: 'gemini-cli-oauth', SERVER_PORT: 3000 },
    initializeConfig: jest.fn().mockResolvedValue({ SERVER_PORT: 3000 }),
}));

jest.unstable_mockModule('../../../src/providers/adapter.js', () => ({
    serviceInstances: {},
}));

jest.unstable_mockModule('../../../src/services/service-manager.js', () => ({
    initApiService: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/common.js', () => ({
    getRequestBody: jest.fn(),
    MODEL_PROTOCOL_PREFIX: {},
}));

jest.unstable_mockModule('../../../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn(),
}));

jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: jest.fn(() => false),
        readFileSync: jest.fn(() => ''),
        writeFileSync: jest.fn(),
        promises: {
            readFile: jest.fn(),
            writeFile: jest.fn().mockResolvedValue(undefined),
        },
    };
});

function createMockRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(),
    };
}

let handleGetConfig;
let handleUpdateConfig;
let handleUpdateAdminPassword;
let getRequestBody;

beforeAll(async () => {
    ({ handleGetConfig, handleUpdateConfig, handleUpdateAdminPassword } =
        await import('../../../src/ui-modules/config-api.js'));
    ({ getRequestBody } = await import('../../../src/utils/common.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('config-api.js - handleGetConfig', () => {
    test('returns 200 with current config', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = { MODEL_PROVIDER: 'gemini-cli-oauth', SERVER_PORT: 3000 };
        await handleGetConfig(req, res, currentConfig);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.MODEL_PROVIDER).toBe('gemini-cli-oauth');
        expect(body.SERVER_PORT).toBe(3000);
        expect(body).toHaveProperty('systemPrompt');
    });

    test('includes systemPrompt as empty string when file does not exist', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = { SYSTEM_PROMPT_FILE_PATH: '/nonexistent/path.txt' };
        await handleGetConfig(req, res, currentConfig);
        const body = JSON.parse(res.end.mock.calls[0][0]);
        // existsSync is mocked to return false
        expect(body.systemPrompt).toBe('');
    });
});

describe('config-api.js - handleUpdateConfig', () => {
    test('updates config fields and returns 200 on success', async () => {
        const { writeFileSync } = await import('fs');
        getRequestBody.mockResolvedValue({ SERVER_PORT: 4000, MODEL_PROVIDER: 'openai-custom' });

        const req = {};
        const res = createMockRes();
        const currentConfig = { MODEL_PROVIDER: 'gemini-cli-oauth', SERVER_PORT: 3000 };
        await handleUpdateConfig(req, res, currentConfig);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
        // The currentConfig should be updated in memory
        expect(currentConfig.SERVER_PORT).toBe(4000);
        expect(currentConfig.MODEL_PROVIDER).toBe('openai-custom');
    });

    test('returns 500 when writeFileSync throws', async () => {
        const fs = await import('fs');
        fs.writeFileSync.mockImplementation(() => {
            throw new Error('Disk full');
        });
        getRequestBody.mockResolvedValue({ SERVER_PORT: 4000 });

        const req = {};
        const res = createMockRes();
        const currentConfig = { SERVER_PORT: 3000 };
        await handleUpdateConfig(req, res, currentConfig);
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});

describe('config-api.js - handleUpdateAdminPassword', () => {
    test('updates password and returns 200 on success', async () => {
        const fs = await import('fs');
        fs.promises.writeFile.mockResolvedValue(undefined);
        getRequestBody.mockResolvedValue({ password: 'newpassword123' });

        const req = {};
        const res = createMockRes();
        await handleUpdateAdminPassword(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.success).toBe(true);
    });

    test('returns 400 when password is empty', async () => {
        getRequestBody.mockResolvedValue({ password: '' });

        const req = {};
        const res = createMockRes();
        await handleUpdateAdminPassword(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error.message).toContain('empty');
    });

    test('returns 400 when password is whitespace only', async () => {
        getRequestBody.mockResolvedValue({ password: '   ' });

        const req = {};
        const res = createMockRes();
        await handleUpdateAdminPassword(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('returns 500 when writeFile throws', async () => {
        const fs = await import('fs');
        fs.promises.writeFile.mockRejectedValue(new Error('Permission denied'));
        getRequestBody.mockResolvedValue({ password: 'newpass' });

        const req = {};
        const res = createMockRes();
        await handleUpdateAdminPassword(req, res);
        expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    });
});
