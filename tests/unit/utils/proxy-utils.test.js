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

    const mod = await import('../../../src/utils/proxy-utils.js');
    parseProxyUrl = mod.parseProxyUrl;
    isProxyEnabledForProvider = mod.isProxyEnabledForProvider;
    getProxyConfigForProvider = mod.getProxyConfigForProvider;
    configureAxiosProxy = mod.configureAxiosProxy;
    getGoogleAuthProxyConfig = mod.getGoogleAuthProxyConfig;
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
