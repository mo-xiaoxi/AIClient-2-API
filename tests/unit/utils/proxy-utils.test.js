/**
 * Unit tests for utils/proxy-utils.js
 *
 * Tests: parseProxyUrl, isProxyEnabledForProvider, getProxyConfigForProvider,
 *        configureAxiosProxy, getGoogleAuthProxyConfig
 * ESM: jest.unstable_mockModule + dynamic import
 *
 * NOTE: tls-sidecar.js must be mocked because it uses import.meta and
 *       spawns a Go binary that cannot run in test environments.
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let parseProxyUrl;
let isProxyEnabledForProvider;
let getProxyConfigForProvider;
let configureAxiosProxy;
let getGoogleAuthProxyConfig;
let isTLSSidecarEnabledForProvider;
let configureTLSSidecar;
let getTLSSidecarMock;

beforeAll(async () => {
    // Mock tls-sidecar — uses import.meta (excluded from Babel transform)
    await jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
        __esModule: true,
        getTLSSidecar: jest.fn().mockReturnValue({
            isReady: jest.fn().mockReturnValue(false),
            wrapAxiosConfig: jest.fn(),
        }),
    }));

    await jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    // Mock proxy agent constructors to avoid real network setup
    await jest.unstable_mockModule('https-proxy-agent', () => ({
        __esModule: true,
        HttpsProxyAgent: jest.fn().mockImplementation((url) => ({ type: 'https', url })),
    }));

    await jest.unstable_mockModule('http-proxy-agent', () => ({
        __esModule: true,
        HttpProxyAgent: jest.fn().mockImplementation((url) => ({ type: 'http', url })),
    }));

    await jest.unstable_mockModule('socks-proxy-agent', () => ({
        __esModule: true,
        SocksProxyAgent: jest.fn().mockImplementation((url) => ({ type: 'socks', url })),
    }));

    const tlsMod = await import('../../../src/utils/tls-sidecar.js');
    getTLSSidecarMock = tlsMod.getTLSSidecar;

    const mod = await import('../../../src/utils/proxy-utils.js');
    parseProxyUrl = mod.parseProxyUrl;
    isProxyEnabledForProvider = mod.isProxyEnabledForProvider;
    getProxyConfigForProvider = mod.getProxyConfigForProvider;
    configureAxiosProxy = mod.configureAxiosProxy;
    getGoogleAuthProxyConfig = mod.getGoogleAuthProxyConfig;
    isTLSSidecarEnabledForProvider = mod.isTLSSidecarEnabledForProvider;
    configureTLSSidecar = mod.configureTLSSidecar;
});

// =============================================================================
// parseProxyUrl
// =============================================================================

describe('parseProxyUrl()', () => {
    test('returns null for null input', () => {
        expect(parseProxyUrl(null)).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(parseProxyUrl('')).toBeNull();
    });

    test('returns null for whitespace-only string', () => {
        expect(parseProxyUrl('   ')).toBeNull();
    });

    test('parses http:// proxy URL and returns httpAgent + httpsAgent', () => {
        const result = parseProxyUrl('http://127.0.0.1:7890');
        expect(result).not.toBeNull();
        expect(result.httpAgent).toBeDefined();
        expect(result.httpsAgent).toBeDefined();
        expect(result.proxyType).toBe('http');
    });

    test('parses https:// proxy URL', () => {
        const result = parseProxyUrl('https://proxy.example.com:8080');
        expect(result).not.toBeNull();
        expect(result.proxyType).toBe('http');
    });

    test('parses socks5:// proxy URL and sets proxyType to socks', () => {
        const result = parseProxyUrl('socks5://127.0.0.1:1080');
        expect(result).not.toBeNull();
        expect(result.proxyType).toBe('socks');
        // Both agents should be the same SocksProxyAgent
        expect(result.httpAgent).toBe(result.httpsAgent);
    });

    test('parses socks4:// proxy URL', () => {
        const result = parseProxyUrl('socks4://127.0.0.1:1080');
        expect(result).not.toBeNull();
        expect(result.proxyType).toBe('socks');
    });

    test('returns null for unsupported protocol', () => {
        const result = parseProxyUrl('ftp://127.0.0.1:21');
        expect(result).toBeNull();
    });

    test('returns null for malformed URL', () => {
        const result = parseProxyUrl('not-a-url!@#$');
        expect(result).toBeNull();
    });
});

// =============================================================================
// isProxyEnabledForProvider
// =============================================================================

describe('isProxyEnabledForProvider()', () => {
    test('returns false when config is null', () => {
        expect(isProxyEnabledForProvider(null, 'gemini-cli-oauth')).toBe(false);
    });

    test('returns false when PROXY_URL is absent', () => {
        const config = { PROXY_ENABLED_PROVIDERS: ['gemini-cli-oauth'] };
        expect(isProxyEnabledForProvider(config, 'gemini-cli-oauth')).toBe(false);
    });

    test('returns false when PROXY_ENABLED_PROVIDERS is absent', () => {
        const config = { PROXY_URL: 'http://127.0.0.1:7890' };
        expect(isProxyEnabledForProvider(config, 'gemini-cli-oauth')).toBe(false);
    });

    test('returns false when PROXY_ENABLED_PROVIDERS is not an array', () => {
        const config = { PROXY_URL: 'http://127.0.0.1:7890', PROXY_ENABLED_PROVIDERS: 'gemini-cli-oauth' };
        expect(isProxyEnabledForProvider(config, 'gemini-cli-oauth')).toBe(false);
    });

    test('returns true when provider is in PROXY_ENABLED_PROVIDERS', () => {
        const config = {
            PROXY_URL: 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: ['gemini-cli-oauth', 'openai-custom'],
        };
        expect(isProxyEnabledForProvider(config, 'gemini-cli-oauth')).toBe(true);
    });

    test('returns false when provider is not in PROXY_ENABLED_PROVIDERS', () => {
        const config = {
            PROXY_URL: 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: ['openai-custom'],
        };
        expect(isProxyEnabledForProvider(config, 'gemini-cli-oauth')).toBe(false);
    });
});

// =============================================================================
// getProxyConfigForProvider
// =============================================================================

describe('getProxyConfigForProvider()', () => {
    test('returns null when proxy is not enabled for provider', () => {
        const config = { PROXY_URL: 'http://127.0.0.1:7890', PROXY_ENABLED_PROVIDERS: [] };
        const result = getProxyConfigForProvider(config, 'gemini-cli-oauth');
        expect(result).toBeNull();
    });

    test('returns proxy config when provider is enabled', () => {
        const config = {
            PROXY_URL: 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: ['gemini-cli-oauth'],
        };
        const result = getProxyConfigForProvider(config, 'gemini-cli-oauth');
        expect(result).not.toBeNull();
        expect(result.proxyType).toBe('http');
    });

    test('returns null when PROXY_URL is invalid', () => {
        const config = {
            PROXY_URL: 'not-a-url!!',
            PROXY_ENABLED_PROVIDERS: ['gemini-cli-oauth'],
        };
        const result = getProxyConfigForProvider(config, 'gemini-cli-oauth');
        expect(result).toBeNull();
    });
});

// =============================================================================
// configureAxiosProxy
// =============================================================================

describe('configureAxiosProxy()', () => {
    test('returns axiosConfig unchanged when proxy is not enabled', () => {
        const config = { PROXY_URL: 'http://127.0.0.1:7890', PROXY_ENABLED_PROVIDERS: [] };
        const axiosConfig = { url: 'https://api.example.com' };
        const result = configureAxiosProxy(axiosConfig, config, 'some-provider');
        expect(result.httpAgent).toBeUndefined();
    });

    test('sets httpAgent and httpsAgent when proxy is enabled', () => {
        const config = {
            PROXY_URL: 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: ['gemini-cli-oauth'],
        };
        const axiosConfig = { url: 'https://api.example.com' };
        const result = configureAxiosProxy(axiosConfig, config, 'gemini-cli-oauth');
        expect(result.httpAgent).toBeDefined();
        expect(result.httpsAgent).toBeDefined();
        expect(result.proxy).toBe(false);
    });
});

// =============================================================================
// getGoogleAuthProxyConfig
// =============================================================================

describe('getGoogleAuthProxyConfig()', () => {
    test('returns null when proxy not enabled', () => {
        const config = { PROXY_URL: 'http://127.0.0.1:7890', PROXY_ENABLED_PROVIDERS: [] };
        expect(getGoogleAuthProxyConfig(config, 'gemini-cli-oauth')).toBeNull();
    });

    test('returns object with agent property when proxy enabled', () => {
        const config = {
            PROXY_URL: 'http://127.0.0.1:7890',
            PROXY_ENABLED_PROVIDERS: ['gemini-cli-oauth'],
        };
        const result = getGoogleAuthProxyConfig(config, 'gemini-cli-oauth');
        expect(result).not.toBeNull();
        expect(result.agent).toBeDefined();
    });
});

// =============================================================================
// isTLSSidecarEnabledForProvider
// =============================================================================

describe('isTLSSidecarEnabledForProvider()', () => {
    test('returns false when config is null', () => {
        expect(isTLSSidecarEnabledForProvider(null, 'grok-custom')).toBe(false);
    });

    test('returns false when TLS_SIDECAR_ENABLED is absent', () => {
        const config = { TLS_SIDECAR_ENABLED_PROVIDERS: ['grok-custom'] };
        expect(isTLSSidecarEnabledForProvider(config, 'grok-custom')).toBe(false);
    });

    test('returns false when TLS_SIDECAR_ENABLED_PROVIDERS is absent', () => {
        const config = { TLS_SIDECAR_ENABLED: true };
        expect(isTLSSidecarEnabledForProvider(config, 'grok-custom')).toBe(false);
    });

    test('returns false when TLS_SIDECAR_ENABLED_PROVIDERS is not an array', () => {
        const config = { TLS_SIDECAR_ENABLED: true, TLS_SIDECAR_ENABLED_PROVIDERS: 'grok-custom' };
        expect(isTLSSidecarEnabledForProvider(config, 'grok-custom')).toBe(false);
    });

    test('returns true when provider is in TLS_SIDECAR_ENABLED_PROVIDERS', () => {
        const config = {
            TLS_SIDECAR_ENABLED: true,
            TLS_SIDECAR_ENABLED_PROVIDERS: ['grok-custom', 'openai-custom'],
        };
        expect(isTLSSidecarEnabledForProvider(config, 'grok-custom')).toBe(true);
    });

    test('returns false when provider is not in TLS_SIDECAR_ENABLED_PROVIDERS', () => {
        const config = {
            TLS_SIDECAR_ENABLED: true,
            TLS_SIDECAR_ENABLED_PROVIDERS: ['openai-custom'],
        };
        expect(isTLSSidecarEnabledForProvider(config, 'grok-custom')).toBe(false);
    });
});

// =============================================================================
// configureTLSSidecar
// =============================================================================

describe('configureTLSSidecar()', () => {
    test('returns axiosConfig unchanged when sidecar is not ready', () => {
        // Default mock: isReady() returns false
        const config = {
            TLS_SIDECAR_ENABLED: true,
            TLS_SIDECAR_ENABLED_PROVIDERS: ['grok-custom'],
        };
        const axiosConfig = { url: 'https://api.x.ai/v1/chat', headers: {} };
        const result = configureTLSSidecar(axiosConfig, config, 'grok-custom');
        expect(result).toBe(axiosConfig);
    });

    test('returns axiosConfig unchanged when provider not enabled', () => {
        const mockWrap = jest.fn();
        getTLSSidecarMock.mockReturnValueOnce({
            isReady: () => true,
            wrapAxiosConfig: mockWrap,
        });
        const config = {
            TLS_SIDECAR_ENABLED: true,
            TLS_SIDECAR_ENABLED_PROVIDERS: ['other-provider'],
        };
        const axiosConfig = { url: 'https://api.x.ai/v1/chat' };
        const result = configureTLSSidecar(axiosConfig, config, 'grok-custom');
        expect(mockWrap).not.toHaveBeenCalled();
        expect(result).toBe(axiosConfig);
    });

    test('calls wrapAxiosConfig when sidecar ready and provider enabled', () => {
        const mockWrap = jest.fn();
        getTLSSidecarMock.mockReturnValueOnce({
            isReady: () => true,
            wrapAxiosConfig: mockWrap,
        });
        const config = {
            TLS_SIDECAR_ENABLED: true,
            TLS_SIDECAR_ENABLED_PROVIDERS: ['grok-custom'],
            TLS_SIDECAR_PROXY_URL: 'http://127.0.0.1:8443',
        };
        const axiosConfig = { url: 'https://api.x.ai/v1/chat' };
        configureTLSSidecar(axiosConfig, config, 'grok-custom');
        expect(mockWrap).toHaveBeenCalledWith(axiosConfig, 'http://127.0.0.1:8443');
    });

    test('resolves relative URL using baseURL when sidecar enabled', () => {
        const mockWrap = jest.fn();
        getTLSSidecarMock.mockReturnValueOnce({
            isReady: () => true,
            wrapAxiosConfig: mockWrap,
        });
        const config = {
            TLS_SIDECAR_ENABLED: true,
            TLS_SIDECAR_ENABLED_PROVIDERS: ['grok-custom'],
        };
        const axiosConfig = {
            url: '/v1/chat/completions',
            baseURL: 'https://api.x.ai',
        };
        configureTLSSidecar(axiosConfig, config, 'grok-custom');
        expect(axiosConfig.url).toBe('https://api.x.ai/v1/chat/completions');
    });

    test('resolves relative URL using defaultBaseUrl when no baseURL', () => {
        const mockWrap = jest.fn();
        getTLSSidecarMock.mockReturnValueOnce({
            isReady: () => true,
            wrapAxiosConfig: mockWrap,
        });
        const config = {
            TLS_SIDECAR_ENABLED: true,
            TLS_SIDECAR_ENABLED_PROVIDERS: ['grok-custom'],
        };
        const axiosConfig = { url: 'v1/chat' };
        configureTLSSidecar(axiosConfig, config, 'grok-custom', 'https://api.x.ai');
        expect(axiosConfig.url).toBe('https://api.x.ai/v1/chat');
    });
});
