/**
 * Unit tests for src/providers/adapter.js
 *
 * Tests: registerAdapter / getServiceAdapter / getRegisteredProviders,
 *        adapter instance caching, ApiServiceAdapter interface.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — must be set up before any dynamic imports
// ---------------------------------------------------------------------------

beforeAll(async () => {
    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    // Mock every provider that adapter.js imports at module level
    const makeServiceMock = (name) => ({
        [name]: jest.fn().mockImplementation(() => ({ isInitialized: false, initialize: jest.fn() }))
    });

    await jest.unstable_mockModule('../../../src/providers/gemini/gemini-core.js', () => makeServiceMock('GeminiApiService'));
    await jest.unstable_mockModule('../../../src/providers/gemini/antigravity-core.js', () => makeServiceMock('AntigravityApiService'));
    await jest.unstable_mockModule('../../../src/providers/openai/openai-core.js', () => makeServiceMock('OpenAIApiService'));
    await jest.unstable_mockModule('../../../src/providers/openai/openai-responses-core.js', () => makeServiceMock('OpenAIResponsesApiService'));
    await jest.unstable_mockModule('../../../src/providers/claude/claude-core.js', () => makeServiceMock('ClaudeApiService'));
    await jest.unstable_mockModule('../../../src/providers/claude/claude-kiro.js', () => makeServiceMock('KiroApiService'));
    await jest.unstable_mockModule('../../../src/providers/openai/qwen-core.js', () => makeServiceMock('QwenApiService'));
    await jest.unstable_mockModule('../../../src/providers/openai/iflow-core.js', () => makeServiceMock('IFlowApiService'));
    await jest.unstable_mockModule('../../../src/providers/openai/codex-core.js', () => makeServiceMock('CodexApiService'));
    await jest.unstable_mockModule('../../../src/providers/forward/forward-core.js', () => makeServiceMock('ForwardApiService'));
    await jest.unstable_mockModule('../../../src/providers/grok/grok-core.js', () => makeServiceMock('GrokApiService'));
    await jest.unstable_mockModule('../../../src/providers/cursor/cursor-core.js', () => makeServiceMock('CursorApiService'));
});

// ---------------------------------------------------------------------------
// Module under test — imported after mocks
// ---------------------------------------------------------------------------

let adapterModule;

beforeAll(async () => {
    adapterModule = await import('../../../src/providers/adapter.js');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiServiceAdapter interface', () => {
    let ApiServiceAdapter;

    beforeAll(() => {
        ApiServiceAdapter = adapterModule.ApiServiceAdapter;
    });

    test('cannot be instantiated directly', () => {
        expect(() => new ApiServiceAdapter()).toThrow(TypeError);
    });

    test('subclass can be constructed', () => {
        class MyAdapter extends ApiServiceAdapter {}
        const inst = new MyAdapter();
        expect(inst).toBeInstanceOf(ApiServiceAdapter);
    });

    test('default generateContent throws', async () => {
        class MyAdapter extends ApiServiceAdapter {}
        const inst = new MyAdapter();
        await expect(inst.generateContent('m', {})).rejects.toThrow("Method 'generateContent()' must be implemented.");
    });

    test('default listModels throws', async () => {
        class MyAdapter extends ApiServiceAdapter {}
        const inst = new MyAdapter();
        await expect(inst.listModels()).rejects.toThrow("Method 'listModels()' must be implemented.");
    });

    test('default generateContentStream throws on first next()', async () => {
        class MyAdapter extends ApiServiceAdapter {}
        const inst = new MyAdapter();
        const gen = inst.generateContentStream('m', {});
        await expect(gen.next()).rejects.toThrow("Method 'generateContentStream()' must be implemented.");
    });
});

describe('registerAdapter / getRegisteredProviders', () => {
    let registerAdapter, getRegisteredProviders;

    beforeAll(() => {
        ({ registerAdapter, getRegisteredProviders } = adapterModule);
    });

    test('built-in providers are already registered on module load', () => {
        const providers = getRegisteredProviders();
        expect(Array.isArray(providers)).toBe(true);
        expect(providers.length).toBeGreaterThan(0);
        // At least these built-in providers should be present
        expect(providers).toContain('openai-custom');
        expect(providers).toContain('forward-api');
        expect(providers).toContain('claude-custom');
    });

    test('registerAdapter adds a new provider', () => {
        const beforeCount = getRegisteredProviders().length;
        class DummyAdapter extends adapterModule.ApiServiceAdapter {
            async generateContent() { return {}; }
            async *generateContentStream() {}
            async listModels() { return {}; }
            async refreshToken() {}
            async forceRefreshToken() {}
            isExpiryDateNear() { return false; }
        }
        registerAdapter('test-dummy-provider', DummyAdapter);
        expect(getRegisteredProviders()).toContain('test-dummy-provider');
        expect(getRegisteredProviders().length).toBe(beforeCount + 1);
    });

    test('registerAdapter can overwrite an existing provider', () => {
        class V1 extends adapterModule.ApiServiceAdapter {
            async generateContent() { return { version: 1 }; }
            async *generateContentStream() {}
            async listModels() { return {}; }
            async refreshToken() {}
            async forceRefreshToken() {}
            isExpiryDateNear() { return false; }
        }
        class V2 extends adapterModule.ApiServiceAdapter {
            async generateContent() { return { version: 2 }; }
            async *generateContentStream() {}
            async listModels() { return {}; }
            async refreshToken() {}
            async forceRefreshToken() {}
            isExpiryDateNear() { return false; }
        }
        registerAdapter('overwrite-test', V1);
        registerAdapter('overwrite-test', V2);
        // After overwrite the new class should be used when getServiceAdapter is called
        const { clearServiceInstancesForTests, getServiceAdapter } = adapterModule;
        clearServiceInstancesForTests();
        const inst = getServiceAdapter({ MODEL_PROVIDER: 'overwrite-test', uuid: 'ow-uuid' });
        // The instance should be a V2
        expect(inst).toBeInstanceOf(V2);
    });
});

describe('getServiceAdapter', () => {
    let getServiceAdapter, clearServiceInstancesForTests;

    beforeAll(() => {
        ({ getServiceAdapter, clearServiceInstancesForTests } = adapterModule);
    });

    beforeEach(() => {
        clearServiceInstancesForTests();
    });

    test('throws for unsupported provider', () => {
        expect(() =>
            getServiceAdapter({ MODEL_PROVIDER: 'unknown-provider-xyz', uuid: 'u1' })
        ).toThrow('Unsupported model provider: unknown-provider-xyz');
    });

    test('returns adapter instance for a registered provider', () => {
        class SimpleAdapter extends adapterModule.ApiServiceAdapter {
            constructor(_cfg) { super(); }
            async generateContent() { return {}; }
            async *generateContentStream() {}
            async listModels() { return {}; }
            async refreshToken() {}
            async forceRefreshToken() {}
            isExpiryDateNear() { return false; }
        }
        adapterModule.registerAdapter('simple-test', SimpleAdapter);
        const inst = getServiceAdapter({ MODEL_PROVIDER: 'simple-test', uuid: 'u2' });
        expect(inst).toBeInstanceOf(SimpleAdapter);
    });

    test('returns same instance (singleton) on second call with same uuid', () => {
        class CachedAdapter extends adapterModule.ApiServiceAdapter {
            constructor(_cfg) { super(); }
            async generateContent() { return {}; }
            async *generateContentStream() {}
            async listModels() { return {}; }
            async refreshToken() {}
            async forceRefreshToken() {}
            isExpiryDateNear() { return false; }
        }
        adapterModule.registerAdapter('cached-test', CachedAdapter);
        const cfg = { MODEL_PROVIDER: 'cached-test', uuid: 'u3' };
        const a = getServiceAdapter(cfg);
        const b = getServiceAdapter(cfg);
        expect(a).toBe(b);
    });

    test('returns different instances for different uuids', () => {
        class MultiAdapter extends adapterModule.ApiServiceAdapter {
            constructor(_cfg) { super(); }
            async generateContent() { return {}; }
            async *generateContentStream() {}
            async listModels() { return {}; }
            async refreshToken() {}
            async forceRefreshToken() {}
            isExpiryDateNear() { return false; }
        }
        adapterModule.registerAdapter('multi-test', MultiAdapter);
        const a = getServiceAdapter({ MODEL_PROVIDER: 'multi-test', uuid: 'ua' });
        const b = getServiceAdapter({ MODEL_PROVIDER: 'multi-test', uuid: 'ub' });
        expect(a).not.toBe(b);
    });

    test('clearServiceInstancesForTests clears the cache', () => {
        class ClearAdapter extends adapterModule.ApiServiceAdapter {
            constructor(_cfg) { super(); }
            async generateContent() { return {}; }
            async *generateContentStream() {}
            async listModels() { return {}; }
            async refreshToken() {}
            async forceRefreshToken() {}
            isExpiryDateNear() { return false; }
        }
        adapterModule.registerAdapter('clear-test', ClearAdapter);
        const cfg = { MODEL_PROVIDER: 'clear-test', uuid: 'uc' };
        const a = getServiceAdapter(cfg);
        clearServiceInstancesForTests();
        const b = getServiceAdapter(cfg);
        expect(a).not.toBe(b);
    });
});
