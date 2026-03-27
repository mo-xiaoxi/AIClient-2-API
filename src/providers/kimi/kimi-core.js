import { hostname } from 'os';
import logger from '../../utils/logger.js';
import { KimiTokenStore } from './kimi-token-store.js';

const KIMI_API_BASE = 'https://api.kimi.com/coding';

// Static fallback models
const KIMI_MODELS = [
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
    { id: 'kimi-k2', name: 'Kimi K2' },
];

/**
 * Strip "kimi-" prefix from model names for upstream API.
 * e.g., "kimi-k2-thinking" → "k2-thinking"
 */
function stripKimiPrefix(model) {
    if (model.toLowerCase().startsWith('kimi-')) {
        return model.slice(5);
    }
    return model;
}

function getDeviceHeaders(deviceId) {
    const platform = process.platform;
    const arch = process.arch;
    return {
        'User-Agent': 'KimiCLI/1.10.6',
        'X-Msh-Platform': 'kimi_cli',
        'X-Msh-Version': '1.10.6',
        'X-Msh-Device-Name': hostname() || 'unknown',
        'X-Msh-Device-Model': `${platform} ${arch}`,
        'X-Msh-Device-Id': deviceId || 'cli-proxy-api-device',
    };
}

export class KimiApiService {
    constructor(config) {
        this.config = config;
        this.uuid = config.uuid;
        this.credFilePath = config.KIMI_OAUTH_CREDS_FILE_PATH;
        this._tokenStore = null;
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;
        const store = new KimiTokenStore(this.credFilePath);
        await store.initialize();
        this._tokenStore = store;
        this.isInitialized = true;
        logger.info(`[Kimi] Initialized (uuid=${this.uuid})`);
    }

    async generateContent(model, requestBody) {
        await this._ensureInitialized();
        const token = await this._tokenStore.getValidAccessToken();
        const upstreamModel = stripKimiPrefix(model);

        const payload = {
            ...requestBody,
            model: upstreamModel,
            stream: false,
        };
        // Remove internal fields
        delete payload._monitorRequestId;
        delete payload._requestBaseUrl;

        const resp = await fetch(`${KIMI_API_BASE}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...getDeviceHeaders(this._tokenStore.deviceId),
            },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const text = await resp.text();
            const err = new Error(`[Kimi] API error (${resp.status}): ${text}`);
            err.status = resp.status;
            throw err;
        }

        const data = await resp.json();
        // Restore original model name in response
        if (data.model) {
            data.model = model;
        }
        return data;
    }

    async *generateContentStream(model, requestBody) {
        await this._ensureInitialized();
        const token = await this._tokenStore.getValidAccessToken();
        const upstreamModel = stripKimiPrefix(model);

        const payload = {
            ...requestBody,
            model: upstreamModel,
            stream: true,
            stream_options: { include_usage: true },
        };
        delete payload._monitorRequestId;
        delete payload._requestBaseUrl;

        const resp = await fetch(`${KIMI_API_BASE}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'Authorization': `Bearer ${token}`,
                ...getDeviceHeaders(this._tokenStore.deviceId),
            },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const text = await resp.text();
            const err = new Error(`[Kimi] Stream API error (${resp.status}): ${text}`);
            err.status = resp.status;
            throw err;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;
                    const dataStr = trimmed.slice(6);
                    if (dataStr === '[DONE]') return;

                    try {
                        const chunk = JSON.parse(dataStr);
                        // Restore original model name
                        if (chunk.model) {
                            chunk.model = model;
                        }
                        yield chunk;
                    } catch {
                        // Skip malformed chunks
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    async listModels() {
        return {
            object: 'list',
            data: KIMI_MODELS.map(m => ({
                id: m.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'moonshot-ai',
            })),
        };
    }

    async refreshToken() {
        if (!this.isInitialized) await this.initialize();
        if (this._tokenStore.isExpiryDateNear(5)) {
            logger.info('[Kimi] Token near expiry, refreshing...');
            await this._tokenStore._doRefresh();
        }
    }

    async forceRefreshToken() {
        if (!this.isInitialized) await this.initialize();
        await this._tokenStore._doRefresh();
    }

    isExpiryDateNear() {
        return this._tokenStore?.isExpiryDateNear(5) || false;
    }

    async getUsageLimits() {
        return {};
    }

    async _ensureInitialized() {
        if (!this.isInitialized) await this.initialize();
    }
}
