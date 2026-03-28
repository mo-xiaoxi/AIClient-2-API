import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// ---- Mock all heavy dependencies to avoid real network/file access ----
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

await jest.unstable_mockModule('../../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: (c) => c,
}));

// Create mock service factories for each provider type
// Each mock service has the minimal interface needed by the adapter
function makeMockService(overrides = {}) {
    return {
        isInitialized: true,
        initialize: jest.fn().mockResolvedValue(undefined),
        generateContent: jest.fn().mockResolvedValue({ choices: [] }),
        generateContentStream: jest.fn(async function* () { yield { choices: [] }; }),
        listModels: jest.fn().mockResolvedValue({ data: [] }),
        initializeAuth: jest.fn().mockResolvedValue(undefined),
        _initializeAuth: jest.fn().mockResolvedValue(undefined),
        refreshToken: jest.fn().mockResolvedValue(undefined),
        forceRefreshToken: jest.fn().mockResolvedValue(undefined),
        isExpiryDateNear: jest.fn().mockReturnValue(false),
        getUsageLimits: jest.fn().mockResolvedValue({}),
        countTokens: jest.fn().mockReturnValue({ input_tokens: 10 }),
        ...overrides,
    };
}

// Mock each provider core module
const mockGeminiService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/gemini/gemini-core.js', () => ({
    GeminiApiService: jest.fn(() => mockGeminiService),
}));

const mockAntigravityService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/gemini/antigravity-core.js', () => ({
    AntigravityApiService: jest.fn(() => mockAntigravityService),
}));

const mockOpenAIService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/openai/openai-core.js', () => ({
    OpenAIApiService: jest.fn(() => mockOpenAIService),
}));

const mockOpenAIResponsesService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/openai/openai-responses-core.js', () => ({
    OpenAIResponsesApiService: jest.fn(() => mockOpenAIResponsesService),
}));

const mockClaudeService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/claude/claude-core.js', () => ({
    ClaudeApiService: jest.fn(() => mockClaudeService),
}));

const mockKiroService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/claude/claude-kiro.js', () => ({
    KiroApiService: jest.fn(() => mockKiroService),
}));

const mockQwenService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/openai/qwen-core.js', () => ({
    QwenApiService: jest.fn(() => mockQwenService),
}));

const mockIFlowService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/openai/iflow-core.js', () => ({
    IFlowApiService: jest.fn(() => mockIFlowService),
}));

const mockCodexService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/openai/codex-core.js', () => ({
    CodexApiService: jest.fn(() => mockCodexService),
}));

const mockForwardService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/forward/forward-core.js', () => ({
    ForwardApiService: jest.fn(() => mockForwardService),
}));

const mockGrokService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/grok/grok-core.js', () => ({
    GrokApiService: jest.fn(() => mockGrokService),
}));

const mockCursorService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/cursor/cursor-core.js', () => ({
    CursorApiService: jest.fn(() => mockCursorService),
}));

const mockKimiService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/kimi/kimi-core.js', () => ({
    KimiApiService: jest.fn(() => mockKimiService),
}));

const mockCopilotService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/copilot/copilot-core.js', () => ({
    CopilotApiService: jest.fn(() => mockCopilotService),
}));

const mockCodeBuddyService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/codebuddy/codebuddy-core.js', () => ({
    CodeBuddyApiService: jest.fn(() => mockCodeBuddyService),
}));

const mockKiloService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/kilo/kilo-core.js', () => ({
    KiloApiService: jest.fn(() => mockKiloService),
}));

const mockGitLabService = makeMockService();
await jest.unstable_mockModule('../../../src/providers/gitlab/gitlab-core.js', () => ({
    GitLabApiService: jest.fn(() => mockGitLabService),
}));

// Import all adapter classes after mocking
const {
    ApiServiceAdapter,
    GeminiApiServiceAdapter,
    AntigravityApiServiceAdapter,
    OpenAIApiServiceAdapter,
    OpenAIResponsesApiServiceAdapter,
    ClaudeApiServiceAdapter,
    KiroApiServiceAdapter,
    QwenApiServiceAdapter,
    IFlowApiServiceAdapter,
    CodexApiServiceAdapter,
    ForwardApiServiceAdapter,
    GrokApiServiceAdapter,
    CursorApiServiceAdapter,
    KimiApiServiceAdapter,
    CopilotApiServiceAdapter,
    CodeBuddyApiServiceAdapter,
    KiloApiServiceAdapter,
    GitLabApiServiceAdapter,
    getServiceAdapter,
    getRegisteredProviders,
    registerAdapter,
    serviceInstances,
    clearServiceInstancesForTests,
} = await import('../../../src/providers/adapter.js');

describe('ApiServiceAdapter (base class)', () => {
    test('cannot be instantiated directly', () => {
        expect(() => new ApiServiceAdapter()).toThrow(TypeError);
    });

    test('throws when abstract methods called on base class', async () => {
        class Concrete extends ApiServiceAdapter {}
        const instance = new Concrete();
        await expect(instance.generateContent()).rejects.toThrow("must be implemented");
        await expect(instance.listModels()).rejects.toThrow("must be implemented");
        await expect(instance.refreshToken()).rejects.toThrow("must be implemented");
        await expect(instance.forceRefreshToken()).rejects.toThrow("must be implemented");
        expect(() => instance.isExpiryDateNear()).toThrow("must be implemented");
    });
});

describe('GeminiApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGeminiService.isInitialized = true;
        adapter = new GeminiApiServiceAdapter({ uuid: 'g1' });
    });

    test('constructor creates a GeminiApiService internally', () => {
        expect(adapter.geminiApiService).toBeDefined();
    });

    test('generateContent delegates to geminiApiService', async () => {
        const expected = { candidates: [] };
        mockGeminiService.generateContent.mockResolvedValueOnce(expected);
        const result = await adapter.generateContent('gemini-2.5-flash', { contents: [] });
        expect(result).toBe(expected);
        expect(mockGeminiService.generateContent).toHaveBeenCalledWith('gemini-2.5-flash', { contents: [] });
    });

    test('generateContent reinitializes when not initialized', async () => {
        mockGeminiService.isInitialized = false;
        mockGeminiService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockGeminiService.initialize).toHaveBeenCalled();
    });

    test('generateContentStream delegates to geminiApiService', async () => {
        const chunks = [];
        for await (const chunk of adapter.generateContentStream('model', {})) {
            chunks.push(chunk);
        }
        expect(mockGeminiService.generateContentStream).toHaveBeenCalled();
    });

    test('listModels delegates to geminiApiService', async () => {
        const models = { models: [] };
        mockGeminiService.listModels.mockResolvedValueOnce(models);
        const result = await adapter.listModels();
        expect(result).toBe(models);
    });

    test('refreshToken calls initializeAuth when expiry is near', async () => {
        mockGeminiService.isExpiryDateNear.mockReturnValueOnce(true);
        await adapter.refreshToken();
        expect(mockGeminiService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('refreshToken does nothing when expiry is not near', async () => {
        mockGeminiService.isExpiryDateNear.mockReturnValueOnce(false);
        await adapter.refreshToken();
        expect(mockGeminiService.initializeAuth).not.toHaveBeenCalled();
    });

    test('forceRefreshToken always calls initializeAuth', async () => {
        await adapter.forceRefreshToken();
        expect(mockGeminiService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('isExpiryDateNear delegates to geminiApiService', () => {
        mockGeminiService.isExpiryDateNear.mockReturnValueOnce(true);
        expect(adapter.isExpiryDateNear()).toBe(true);
    });

    test('getUsageLimits delegates to geminiApiService', async () => {
        const limits = { daily: 1000 };
        mockGeminiService.getUsageLimits.mockResolvedValueOnce(limits);
        const result = await adapter.getUsageLimits();
        expect(result).toBe(limits);
    });
});

describe('AntigravityApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockAntigravityService.isInitialized = true;
        adapter = new AntigravityApiServiceAdapter({ uuid: 'a1' });
    });

    test('generateContent delegates to antigravityApiService', async () => {
        mockAntigravityService.generateContent.mockResolvedValueOnce({ ok: true });
        const result = await adapter.generateContent('model', {});
        expect(result).toEqual({ ok: true });
    });

    test('refreshToken calls initializeAuth when expiry is near', async () => {
        mockAntigravityService.isExpiryDateNear.mockReturnValueOnce(true);
        await adapter.refreshToken();
        expect(mockAntigravityService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('refreshToken does nothing when expiry is not near', async () => {
        mockAntigravityService.isExpiryDateNear.mockReturnValueOnce(false);
        await adapter.refreshToken();
        expect(mockAntigravityService.initializeAuth).not.toHaveBeenCalled();
    });

    test('forceRefreshToken calls initializeAuth', async () => {
        await adapter.forceRefreshToken();
        expect(mockAntigravityService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('isExpiryDateNear delegates to service', () => {
        mockAntigravityService.isExpiryDateNear.mockReturnValueOnce(false);
        expect(adapter.isExpiryDateNear()).toBe(false);
    });
});

describe('OpenAIApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        adapter = new OpenAIApiServiceAdapter({ uuid: 'o1' });
    });

    test('generateContent delegates to openAIApiService', async () => {
        mockOpenAIService.generateContent.mockResolvedValueOnce({ choices: [{ message: { content: 'Hi' } }] });
        const result = await adapter.generateContent('gpt-4o', { messages: [] });
        expect(result.choices[0].message.content).toBe('Hi');
    });

    test('listModels delegates to openAIApiService', async () => {
        const models = { object: 'list', data: [] };
        mockOpenAIService.listModels.mockResolvedValueOnce(models);
        const result = await adapter.listModels();
        expect(result).toBe(models);
    });

    test('refreshToken resolves immediately (static keys)', async () => {
        await expect(adapter.refreshToken()).resolves.toBeUndefined();
    });

    test('forceRefreshToken resolves immediately', async () => {
        await expect(adapter.forceRefreshToken()).resolves.toBeUndefined();
    });

    test('isExpiryDateNear always returns false', () => {
        expect(adapter.isExpiryDateNear()).toBe(false);
    });
});

describe('OpenAIResponsesApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        adapter = new OpenAIResponsesApiServiceAdapter({ uuid: 'r1' });
    });

    test('generateContent delegates to openAIResponsesApiService', async () => {
        mockOpenAIResponsesService.generateContent.mockResolvedValueOnce({ output: [] });
        const result = await adapter.generateContent('gpt-4o', { input: 'hello' });
        expect(result).toEqual({ output: [] });
    });

    test('refreshToken resolves immediately', async () => {
        await expect(adapter.refreshToken()).resolves.toBeUndefined();
    });

    test('forceRefreshToken resolves immediately', async () => {
        await expect(adapter.forceRefreshToken()).resolves.toBeUndefined();
    });

    test('isExpiryDateNear returns false', () => {
        expect(adapter.isExpiryDateNear()).toBe(false);
    });
});

describe('ClaudeApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        adapter = new ClaudeApiServiceAdapter({ uuid: 'c1' });
    });

    test('generateContent delegates to claudeApiService', async () => {
        mockClaudeService.generateContent.mockResolvedValueOnce({ content: [{ text: 'Hello' }] });
        const result = await adapter.generateContent('claude-3-haiku', { messages: [] });
        expect(result.content[0].text).toBe('Hello');
    });

    test('listModels delegates to claudeApiService', async () => {
        const models = { data: [] };
        mockClaudeService.listModels.mockResolvedValueOnce(models);
        const result = await adapter.listModels();
        expect(result).toBe(models);
    });

    test('refreshToken resolves immediately', async () => {
        await expect(adapter.refreshToken()).resolves.toBeUndefined();
    });

    test('forceRefreshToken resolves immediately', async () => {
        await expect(adapter.forceRefreshToken()).resolves.toBeUndefined();
    });

    test('isExpiryDateNear returns false', () => {
        expect(adapter.isExpiryDateNear()).toBe(false);
    });
});

describe('KiroApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockKiroService.isInitialized = true;
        adapter = new KiroApiServiceAdapter({ uuid: 'k1' });
    });

    test('generateContent delegates to kiroApiService', async () => {
        mockKiroService.generateContent.mockResolvedValueOnce({ content: [] });
        const result = await adapter.generateContent('claude-haiku', {});
        expect(mockKiroService.generateContent).toHaveBeenCalled();
    });

    test('generateContent reinitializes when not initialized', async () => {
        mockKiroService.isInitialized = false;
        mockKiroService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockKiroService.initialize).toHaveBeenCalled();
    });

    test('listModels delegates to kiroApiService', async () => {
        mockKiroService.isInitialized = true;
        const models = { data: [] };
        mockKiroService.listModels.mockResolvedValueOnce(models);
        const result = await adapter.listModels();
        expect(result).toBe(models);
    });

    test('refreshToken calls initializeAuth when expiry near', async () => {
        mockKiroService.isExpiryDateNear.mockReturnValueOnce(true);
        await adapter.refreshToken();
        expect(mockKiroService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('refreshToken does nothing when expiry not near', async () => {
        mockKiroService.isExpiryDateNear.mockReturnValueOnce(false);
        await adapter.refreshToken();
        expect(mockKiroService.initializeAuth).not.toHaveBeenCalled();
    });

    test('forceRefreshToken calls initializeAuth', async () => {
        await adapter.forceRefreshToken();
        expect(mockKiroService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('countTokens delegates to kiroApiService', () => {
        const result = adapter.countTokens({ messages: [] });
        expect(mockKiroService.countTokens).toHaveBeenCalled();
        expect(result).toEqual({ input_tokens: 10 });
    });
});

describe('QwenApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockQwenService.isInitialized = true;
        adapter = new QwenApiServiceAdapter({ uuid: 'q1' });
    });

    test('generateContent delegates to qwenApiService', async () => {
        mockQwenService.generateContent.mockResolvedValueOnce({ choices: [] });
        const result = await adapter.generateContent('qwen3', {});
        expect(mockQwenService.generateContent).toHaveBeenCalled();
    });

    test('refreshToken calls _initializeAuth when expiry near', async () => {
        mockQwenService.isExpiryDateNear.mockReturnValueOnce(true);
        await adapter.refreshToken();
        expect(mockQwenService._initializeAuth).toHaveBeenCalledWith(true);
    });

    test('forceRefreshToken calls _initializeAuth', async () => {
        await adapter.forceRefreshToken();
        expect(mockQwenService._initializeAuth).toHaveBeenCalledWith(true);
    });

    test('isExpiryDateNear delegates to service', () => {
        mockQwenService.isExpiryDateNear.mockReturnValueOnce(true);
        expect(adapter.isExpiryDateNear()).toBe(true);
    });
});

describe('IFlowApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockIFlowService.isInitialized = true;
        adapter = new IFlowApiServiceAdapter({ uuid: 'if1' });
    });

    test('generateContent delegates to iflowApiService', async () => {
        mockIFlowService.generateContent.mockResolvedValueOnce({ choices: [] });
        await adapter.generateContent('model', {});
        expect(mockIFlowService.generateContent).toHaveBeenCalled();
    });

    test('refreshToken calls initializeAuth when expiry near', async () => {
        mockIFlowService.isExpiryDateNear.mockReturnValueOnce(true);
        await adapter.refreshToken();
        expect(mockIFlowService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('forceRefreshToken calls initializeAuth', async () => {
        await adapter.forceRefreshToken();
        expect(mockIFlowService.initializeAuth).toHaveBeenCalledWith(true);
    });
});

describe('CodexApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCodexService.isInitialized = true;
        adapter = new CodexApiServiceAdapter({ uuid: 'cx1' });
    });

    test('generateContent delegates to codexApiService', async () => {
        mockCodexService.generateContent.mockResolvedValueOnce({ output: [] });
        const result = await adapter.generateContent('codex-mini', {});
        expect(mockCodexService.generateContent).toHaveBeenCalled();
    });

    test('generateContent reinitializes when not initialized', async () => {
        mockCodexService.isInitialized = false;
        mockCodexService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockCodexService.initialize).toHaveBeenCalled();
    });

    test('listModels delegates to codexApiService', async () => {
        const models = { data: [] };
        mockCodexService.listModels.mockResolvedValueOnce(models);
        const result = await adapter.listModels();
        expect(result).toBe(models);
    });

    test('refreshToken calls initializeAuth when expiry near', async () => {
        mockCodexService.isExpiryDateNear.mockReturnValueOnce(true);
        await adapter.refreshToken();
        expect(mockCodexService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('forceRefreshToken calls initializeAuth', async () => {
        await adapter.forceRefreshToken();
        expect(mockCodexService.initializeAuth).toHaveBeenCalledWith(true);
    });

    test('getUsageLimits delegates to codexApiService', async () => {
        const limits = { total: 500 };
        mockCodexService.getUsageLimits.mockResolvedValueOnce(limits);
        const result = await adapter.getUsageLimits();
        expect(result).toBe(limits);
    });
});

describe('ForwardApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        adapter = new ForwardApiServiceAdapter({ uuid: 'f1' });
    });

    test('generateContent delegates to forwardApiService', async () => {
        mockForwardService.generateContent.mockResolvedValueOnce({ choices: [] });
        const result = await adapter.generateContent('model', {});
        expect(mockForwardService.generateContent).toHaveBeenCalled();
    });

    test('listModels delegates to forwardApiService', async () => {
        mockForwardService.listModels.mockResolvedValueOnce({ data: [] });
        const result = await adapter.listModels();
        expect(mockForwardService.listModels).toHaveBeenCalled();
    });

    test('refreshToken resolves immediately', async () => {
        await expect(adapter.refreshToken()).resolves.toBeUndefined();
    });

    test('forceRefreshToken resolves immediately', async () => {
        await expect(adapter.forceRefreshToken()).resolves.toBeUndefined();
    });

    test('isExpiryDateNear returns false', () => {
        expect(adapter.isExpiryDateNear()).toBe(false);
    });
});

describe('GrokApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGrokService.isInitialized = true;
        adapter = new GrokApiServiceAdapter({ uuid: 'gk1' });
    });

    test('generateContent delegates to grokApiService', async () => {
        mockGrokService.generateContent.mockResolvedValueOnce({ message: 'Hi' });
        const result = await adapter.generateContent('grok-3', {});
        expect(mockGrokService.generateContent).toHaveBeenCalled();
    });

    test('generateContent initializes when not initialized', async () => {
        mockGrokService.isInitialized = false;
        mockGrokService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockGrokService.initialize).toHaveBeenCalled();
    });

    test('refreshToken delegates to grokApiService', async () => {
        await adapter.refreshToken();
        expect(mockGrokService.refreshToken).toHaveBeenCalled();
    });

    test('forceRefreshToken delegates to grokApiService.refreshToken', async () => {
        await adapter.forceRefreshToken();
        expect(mockGrokService.refreshToken).toHaveBeenCalled();
    });

    test('isExpiryDateNear delegates to grokApiService', () => {
        mockGrokService.isExpiryDateNear.mockReturnValueOnce(true);
        expect(adapter.isExpiryDateNear()).toBe(true);
    });

    test('getUsageLimits delegates to grokApiService', async () => {
        const limits = { grok: 'unlimited' };
        mockGrokService.getUsageLimits.mockResolvedValueOnce(limits);
        const result = await adapter.getUsageLimits();
        expect(result).toBe(limits);
    });
});

describe('CursorApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCursorService.isInitialized = true;
        adapter = new CursorApiServiceAdapter({ uuid: 'cur1' });
    });

    test('generateContent delegates to cursorApiService', async () => {
        mockCursorService.generateContent.mockResolvedValueOnce({ choices: [] });
        const result = await adapter.generateContent('claude-3-5-sonnet', {});
        expect(mockCursorService.generateContent).toHaveBeenCalled();
    });

    test('generateContent reinitializes when not initialized', async () => {
        mockCursorService.isInitialized = false;
        mockCursorService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockCursorService.initialize).toHaveBeenCalled();
    });

    test('listModels delegates to cursorApiService', async () => {
        mockCursorService.listModels.mockResolvedValueOnce({ data: [] });
        await adapter.listModels();
        expect(mockCursorService.listModels).toHaveBeenCalled();
    });

    test('refreshToken calls cursorApiService.refreshToken when expiry near', async () => {
        mockCursorService.isExpiryDateNear.mockReturnValueOnce(true);
        await adapter.refreshToken();
        expect(mockCursorService.refreshToken).toHaveBeenCalled();
    });

    test('refreshToken does nothing when expiry not near', async () => {
        mockCursorService.isExpiryDateNear.mockReturnValueOnce(false);
        await adapter.refreshToken();
        expect(mockCursorService.refreshToken).not.toHaveBeenCalled();
    });

    test('forceRefreshToken calls cursorApiService.forceRefreshToken', async () => {
        await adapter.forceRefreshToken();
        expect(mockCursorService.forceRefreshToken).toHaveBeenCalled();
    });

    test('isExpiryDateNear delegates to cursorApiService', () => {
        mockCursorService.isExpiryDateNear.mockReturnValueOnce(false);
        expect(adapter.isExpiryDateNear()).toBe(false);
    });

    test('getUsageLimits returns empty object', async () => {
        const result = await adapter.getUsageLimits();
        expect(result).toEqual({});
    });
});

describe('getServiceAdapter factory', () => {
    beforeEach(() => {
        clearServiceInstancesForTests();
        jest.clearAllMocks();
        mockGeminiService.isInitialized = true;
        mockOpenAIService.isInitialized = true;
    });

    test('creates and caches adapter by provider+uuid', () => {
        const config = { MODEL_PROVIDER: 'gemini-cli-oauth', uuid: 'g-unique' };
        const adapter1 = getServiceAdapter(config);
        const adapter2 = getServiceAdapter(config);
        expect(adapter1).toBe(adapter2); // Same instance (cached)
    });

    test('creates different adapters for different UUIDs', () => {
        const config1 = { MODEL_PROVIDER: 'gemini-cli-oauth', uuid: 'uuid-a' };
        const config2 = { MODEL_PROVIDER: 'gemini-cli-oauth', uuid: 'uuid-b' };
        const adapter1 = getServiceAdapter(config1);
        const adapter2 = getServiceAdapter(config2);
        expect(adapter1).not.toBe(adapter2);
    });

    test('throws for unsupported provider', () => {
        const config = { MODEL_PROVIDER: 'totally-unknown-provider', uuid: 'x1' };
        expect(() => getServiceAdapter(config)).toThrow('Unsupported model provider');
    });

    test('creates adapter for openai-custom', () => {
        const config = { MODEL_PROVIDER: 'openai-custom', uuid: 'oc1' };
        const adapter = getServiceAdapter(config);
        expect(adapter).toBeInstanceOf(OpenAIApiServiceAdapter);
    });

    test('creates adapter for claude-custom', () => {
        const config = { MODEL_PROVIDER: 'claude-custom', uuid: 'cc1' };
        const adapter = getServiceAdapter(config);
        expect(adapter).toBeInstanceOf(ClaudeApiServiceAdapter);
    });

    test('creates adapter for forward-api', () => {
        const config = { MODEL_PROVIDER: 'forward-api', uuid: 'fa1' };
        const adapter = getServiceAdapter(config);
        expect(adapter).toBeInstanceOf(ForwardApiServiceAdapter);
    });
});

describe('getRegisteredProviders', () => {
    test('returns array of registered provider names', () => {
        const providers = getRegisteredProviders();
        expect(Array.isArray(providers)).toBe(true);
        expect(providers).toContain('openai-custom');
        expect(providers).toContain('gemini-cli-oauth');
        expect(providers).toContain('claude-custom');
        expect(providers).toContain('forward-api');
        expect(providers).toContain('grok-custom');
    });
});

describe('clearServiceInstancesForTests', () => {
    test('clears cached service instances', () => {
        clearServiceInstancesForTests();
        const config = { MODEL_PROVIDER: 'openai-custom', uuid: 'clear-test' };
        const adapter1 = getServiceAdapter(config);
        clearServiceInstancesForTests();
        const adapter2 = getServiceAdapter(config);
        // After clearing, a new instance should be created
        expect(adapter1).not.toBe(adapter2);
    });
});

describe('KimiApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockKimiService.isInitialized = true;
        adapter = new KimiApiServiceAdapter({ uuid: 'km1' });
    });

    test('generateContent delegates to kimiApiService', async () => {
        mockKimiService.generateContent.mockResolvedValueOnce({ choices: [] });
        await adapter.generateContent('moonshot-v1-8k', {});
        expect(mockKimiService.generateContent).toHaveBeenCalled();
    });

    test('generateContent initializes when not initialized', async () => {
        mockKimiService.isInitialized = false;
        mockKimiService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockKimiService.initialize).toHaveBeenCalled();
    });

    test('generateContentStream delegates to kimiApiService', async () => {
        const chunks = [];
        for await (const c of adapter.generateContentStream('moonshot-v1-8k', {})) {
            chunks.push(c);
        }
        expect(mockKimiService.generateContentStream).toHaveBeenCalled();
    });

    test('generateContentStream initializes when not initialized', async () => {
        mockKimiService.isInitialized = false;
        for await (const _ of adapter.generateContentStream('model', {})) { /* drain */ }
        expect(mockKimiService.initialize).toHaveBeenCalled();
    });

    test('listModels delegates to kimiApiService', async () => {
        await adapter.listModels();
        expect(mockKimiService.listModels).toHaveBeenCalled();
    });

    test('refreshToken calls kimiApiService.refreshToken when expiry near', async () => {
        mockKimiService.isExpiryDateNear.mockReturnValue(true);
        await adapter.refreshToken();
        expect(mockKimiService.refreshToken).toHaveBeenCalled();
    });

    test('refreshToken skips refresh when expiry not near', async () => {
        mockKimiService.isExpiryDateNear.mockReturnValue(false);
        await adapter.refreshToken();
        expect(mockKimiService.refreshToken).not.toHaveBeenCalled();
    });

    test('forceRefreshToken delegates to kimiApiService', async () => {
        await adapter.forceRefreshToken();
        expect(mockKimiService.forceRefreshToken).toHaveBeenCalled();
    });

    test('isExpiryDateNear delegates to kimiApiService', () => {
        mockKimiService.isExpiryDateNear.mockReturnValue(true);
        expect(adapter.isExpiryDateNear()).toBe(true);
    });

    test('getUsageLimits returns empty object', async () => {
        expect(await adapter.getUsageLimits()).toEqual({});
    });
});

describe('CopilotApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCopilotService.isInitialized = true;
        adapter = new CopilotApiServiceAdapter({ uuid: 'cp1' });
    });

    test('generateContent delegates to copilotApiService', async () => {
        mockCopilotService.generateContent.mockResolvedValueOnce({ choices: [] });
        await adapter.generateContent('gpt-4o', {});
        expect(mockCopilotService.generateContent).toHaveBeenCalled();
    });

    test('generateContent initializes when not initialized', async () => {
        mockCopilotService.isInitialized = false;
        mockCopilotService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockCopilotService.initialize).toHaveBeenCalled();
    });

    test('generateContentStream delegates to copilotApiService', async () => {
        for await (const _ of adapter.generateContentStream('gpt-4o', {})) { /* drain */ }
        expect(mockCopilotService.generateContentStream).toHaveBeenCalled();
    });

    test('listModels delegates to copilotApiService', async () => {
        await adapter.listModels();
        expect(mockCopilotService.listModels).toHaveBeenCalled();
    });

    test('refreshToken calls copilotApiService.refreshToken when expiry near', async () => {
        mockCopilotService.isExpiryDateNear.mockReturnValue(true);
        await adapter.refreshToken();
        expect(mockCopilotService.refreshToken).toHaveBeenCalled();
    });

    test('refreshToken skips when expiry not near', async () => {
        mockCopilotService.isExpiryDateNear.mockReturnValue(false);
        await adapter.refreshToken();
        expect(mockCopilotService.refreshToken).not.toHaveBeenCalled();
    });

    test('forceRefreshToken delegates to copilotApiService', async () => {
        await adapter.forceRefreshToken();
        expect(mockCopilotService.forceRefreshToken).toHaveBeenCalled();
    });

    test('isExpiryDateNear delegates to copilotApiService', () => {
        mockCopilotService.isExpiryDateNear.mockReturnValue(true);
        expect(adapter.isExpiryDateNear()).toBe(true);
    });

    test('getUsageLimits returns empty object', async () => {
        expect(await adapter.getUsageLimits()).toEqual({});
    });
});

describe('CodeBuddyApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCodeBuddyService.isInitialized = true;
        adapter = new CodeBuddyApiServiceAdapter({ uuid: 'cb1' });
    });

    test('generateContent delegates to codeBuddyApiService', async () => {
        mockCodeBuddyService.generateContent.mockResolvedValueOnce({ choices: [] });
        await adapter.generateContent('GLM-5.0', {});
        expect(mockCodeBuddyService.generateContent).toHaveBeenCalled();
    });

    test('generateContent initializes when not initialized', async () => {
        mockCodeBuddyService.isInitialized = false;
        mockCodeBuddyService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockCodeBuddyService.initialize).toHaveBeenCalled();
    });

    test('generateContentStream delegates to codeBuddyApiService', async () => {
        for await (const _ of adapter.generateContentStream('GLM-5.0', {})) { /* drain */ }
        expect(mockCodeBuddyService.generateContentStream).toHaveBeenCalled();
    });

    test('listModels delegates to codeBuddyApiService', async () => {
        await adapter.listModels();
        expect(mockCodeBuddyService.listModels).toHaveBeenCalled();
    });

    test('refreshToken calls codeBuddyApiService.refreshToken when expiry near', async () => {
        mockCodeBuddyService.isExpiryDateNear.mockReturnValue(true);
        await adapter.refreshToken();
        expect(mockCodeBuddyService.refreshToken).toHaveBeenCalled();
    });

    test('refreshToken skips when expiry not near', async () => {
        mockCodeBuddyService.isExpiryDateNear.mockReturnValue(false);
        await adapter.refreshToken();
        expect(mockCodeBuddyService.refreshToken).not.toHaveBeenCalled();
    });

    test('forceRefreshToken delegates to codeBuddyApiService', async () => {
        await adapter.forceRefreshToken();
        expect(mockCodeBuddyService.forceRefreshToken).toHaveBeenCalled();
    });

    test('isExpiryDateNear delegates to codeBuddyApiService', () => {
        mockCodeBuddyService.isExpiryDateNear.mockReturnValue(false);
        expect(adapter.isExpiryDateNear()).toBe(false);
    });

    test('getUsageLimits returns empty object', async () => {
        expect(await adapter.getUsageLimits()).toEqual({});
    });
});

describe('KiloApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockKiloService.isInitialized = true;
        adapter = new KiloApiServiceAdapter({ uuid: 'kl1' });
    });

    test('generateContent delegates to kiloApiService', async () => {
        mockKiloService.generateContent.mockResolvedValueOnce({ choices: [] });
        await adapter.generateContent('kilo/auto', {});
        expect(mockKiloService.generateContent).toHaveBeenCalled();
    });

    test('generateContent initializes when not initialized', async () => {
        mockKiloService.isInitialized = false;
        mockKiloService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockKiloService.initialize).toHaveBeenCalled();
    });

    test('generateContentStream delegates to kiloApiService', async () => {
        for await (const _ of adapter.generateContentStream('kilo/auto', {})) { /* drain */ }
        expect(mockKiloService.generateContentStream).toHaveBeenCalled();
    });

    test('listModels delegates to kiloApiService', async () => {
        await adapter.listModels();
        expect(mockKiloService.listModels).toHaveBeenCalled();
    });

    test('refreshToken delegates to kiloApiService.refreshToken', async () => {
        await adapter.refreshToken();
        expect(mockKiloService.refreshToken).toHaveBeenCalled();
    });

    test('forceRefreshToken delegates to kiloApiService', async () => {
        await adapter.forceRefreshToken();
        expect(mockKiloService.forceRefreshToken).toHaveBeenCalled();
    });

    test('isExpiryDateNear delegates to kiloApiService', () => {
        mockKiloService.isExpiryDateNear.mockReturnValue(false);
        expect(adapter.isExpiryDateNear()).toBe(false);
    });

    test('getUsageLimits returns empty object', async () => {
        expect(await adapter.getUsageLimits()).toEqual({});
    });
});

describe('GitLabApiServiceAdapter', () => {
    let adapter;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGitLabService.isInitialized = true;
        adapter = new GitLabApiServiceAdapter({ uuid: 'gl1' });
    });

    test('generateContent delegates to gitlabApiService', async () => {
        mockGitLabService.generateContent.mockResolvedValueOnce({ choices: [] });
        await adapter.generateContent('gitlab-duo', {});
        expect(mockGitLabService.generateContent).toHaveBeenCalled();
    });

    test('generateContent initializes when not initialized', async () => {
        mockGitLabService.isInitialized = false;
        mockGitLabService.generateContent.mockResolvedValueOnce({});
        await adapter.generateContent('model', {});
        expect(mockGitLabService.initialize).toHaveBeenCalled();
    });

    test('generateContentStream delegates to gitlabApiService', async () => {
        for await (const _ of adapter.generateContentStream('gitlab-duo', {})) { /* drain */ }
        expect(mockGitLabService.generateContentStream).toHaveBeenCalled();
    });

    test('listModels delegates to gitlabApiService', async () => {
        await adapter.listModels();
        expect(mockGitLabService.listModels).toHaveBeenCalled();
    });

    test('refreshToken calls gitlabApiService.refreshToken when expiry near', async () => {
        mockGitLabService.isExpiryDateNear.mockReturnValue(true);
        await adapter.refreshToken();
        expect(mockGitLabService.refreshToken).toHaveBeenCalled();
    });

    test('refreshToken skips when expiry not near', async () => {
        mockGitLabService.isExpiryDateNear.mockReturnValue(false);
        await adapter.refreshToken();
        expect(mockGitLabService.refreshToken).not.toHaveBeenCalled();
    });

    test('forceRefreshToken delegates to gitlabApiService', async () => {
        await adapter.forceRefreshToken();
        expect(mockGitLabService.forceRefreshToken).toHaveBeenCalled();
    });

    test('isExpiryDateNear delegates to gitlabApiService', () => {
        mockGitLabService.isExpiryDateNear.mockReturnValue(true);
        expect(adapter.isExpiryDateNear()).toBe(true);
    });

    test('getUsageLimits returns empty object', async () => {
        expect(await adapter.getUsageLimits()).toEqual({});
    });
});
