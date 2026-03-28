/**
 * Unit tests for cursor-core.js
 *
 * Tests: end-stream error handling in non-streaming and streaming paths,
 *        ensuring Cursor API errors are properly surfaced instead of
 *        silently returning empty content.
 *
 * ESM: jest.unstable_mockModule + dynamic import (CI runs in ESM mode).
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Constants (hardcoded to avoid import-order issues with mocks)
// ---------------------------------------------------------------------------

const CONNECT_END_STREAM_FLAG = 0x02;

// ---------------------------------------------------------------------------
// Controllable fake H2 stream / client
// ---------------------------------------------------------------------------

function createMockH2Stream() {
    const stream = new EventEmitter();
    stream.write = jest.fn();
    stream.closed = false;
    stream.destroyed = false;
    stream.close = jest.fn();
    return stream;
}

function createMockH2Client() {
    return { close: jest.fn() };
}

const mockH2Stream = createMockH2Stream();

// ---------------------------------------------------------------------------
// Helpers — frame builders
// ---------------------------------------------------------------------------

function buildFrame(flags, payload) {
    const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(payloadBuf.length, 1);
    return Buffer.concat([header, payloadBuf]);
}

function buildErrorEndStreamFrame(errorMessage, modelName) {
    const payload = JSON.stringify({
        error: {
            code: 'not_found',
            message: errorMessage,
            details: [{
                type: 'aiserver.v1.ErrorDetails',
                debug: {
                    error: 'ERROR_BAD_MODEL_NAME',
                    details: {
                        title: 'AI Model Not Found',
                        detail: `Model name is not valid: "${modelName}"`,
                        isRetryable: false,
                    },
                    isExpected: true,
                },
            }],
        },
    });
    return buildFrame(CONNECT_END_STREAM_FLAG, payload);
}

function buildNormalEndStreamFrame() {
    return buildFrame(CONNECT_END_STREAM_FLAG, '{}');
}

function buildDataFrame(payload) {
    return buildFrame(0x00, payload || 'mock-protobuf-data');
}

// ---------------------------------------------------------------------------
// Mocks + dynamic imports
// ---------------------------------------------------------------------------

let CursorApiService;
let mockProcessAgentServerMessage;

beforeAll(async () => {
    // Logger
    await jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    // Token store
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-token-store.js', () => ({
        CursorTokenStore: jest.fn().mockImplementation(() => ({
            initialize: jest.fn(),
            getValidAccessToken: jest.fn(async () => 'mock-token'),
            isExpiryDateNear: jest.fn(() => false),
        })),
    }));

    // Session
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-session.js', () => ({
        deriveSessionKey: jest.fn(() => 'session-key'),
        getSession: jest.fn(() => null),
        removeSession: jest.fn(),
        saveSession: jest.fn(),
        cleanupSession: jest.fn(),
    }));

    // H2 — includes Connect Protocol constants now imported from cursor-h2.js
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-h2.js', () => {
        // Re-import the real CONNECT_ERROR_HTTP_MAP and parseConnectErrorFrame
        // so end-stream error frames are parsed correctly in tests
        const CONNECT_ERROR_HTTP_MAP_REAL = {
            'unauthenticated': 401, 'permission_denied': 403, 'not_found': 404,
            'resource_exhausted': 429, 'invalid_argument': 400, 'failed_precondition': 400,
            'unimplemented': 501, 'unavailable': 503, 'internal': 500, 'unknown': 502,
            'canceled': 499, 'deadline_exceeded': 504,
        };
        return {
            CONNECT_END_STREAM_FLAG,
            frameConnectMessage: jest.fn(() => Buffer.from('framed')),
            parseConnectErrorFrame: jest.fn((data) => {
                try {
                    const text = new TextDecoder().decode(data);
                    const p = JSON.parse(text);
                    if (p?.error) {
                        const code = p.error.code ?? 'unknown';
                        const message = p.error.message ?? 'Unknown error';
                        const detail = p.error.details?.[0]?.debug?.details?.detail || message;
                        const httpStatus = CONNECT_ERROR_HTTP_MAP_REAL[code] ?? 502;
                        const err = Object.assign(new Error(detail), { status: httpStatus, connectCode: code });
                        return { error: err, httpStatus };
                    }
                    return null;
                } catch {
                    return {
                        error: Object.assign(new Error('Failed to parse Cursor API error response'), { status: 502 }),
                        httpStatus: 502,
                    };
                }
            }),
            h2RequestStream: jest.fn(() => ({
                client: createMockH2Client(),
                stream: mockH2Stream,
            })),
        };
    });

    // Truncation
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-truncation.js', () => ({
        isTruncated: jest.fn(() => false),
        autoContinueFull: jest.fn(),
        autoContinueStream: jest.fn(),
    }));

    // Compression
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-compression.js', () => ({
        compressMessages: jest.fn((msgs) => msgs),
    }));

    // Stream guard
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-stream-guard.js', () => ({
        createStreamGuard: jest.fn(() => ({
            push: jest.fn((text) => text),
            finish: jest.fn(() => ''),
            hasUnlocked: jest.fn(() => true),
        })),
    }));

    // Vision
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-vision.js', () => ({
        preprocessImages: jest.fn(async (msgs) => msgs),
    }));

    // Protobuf helpers
    mockProcessAgentServerMessage = jest.fn();
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-protobuf.js', () => ({
        parseMessages: jest.fn(() => ({
            systemPrompt: 'You are a helpful assistant.',
            userText: 'Hello',
            images: [],
            turns: [],
            toolResults: [],
        })),
        buildCursorAgentRequest: jest.fn(() => ({
            requestBytes: Buffer.from('mock-request'),
            blobStore: new Map(),
        })),
        buildHeartbeatBytes: jest.fn(() => Buffer.from('heartbeat')),
        buildMcpToolDefinitions: jest.fn(() => []),
        processAgentServerMessage: mockProcessAgentServerMessage,
        buildToolResultFrames: jest.fn(() => []),
    }));

    // Proto schemas
    await jest.unstable_mockModule('../../../../src/providers/cursor/proto/agent_pb.js', () => ({
        GetUsableModelsRequestSchema: {},
        GetUsableModelsResponseSchema: {},
    }));

    // @bufbuild/protobuf
    await jest.unstable_mockModule('@bufbuild/protobuf', () => ({
        create: jest.fn(),
        fromBinary: jest.fn(),
        toBinary: jest.fn(() => Buffer.from('mock')),
    }));

    // Now import the module under test
    const mod = await import('../../../../src/providers/cursor/cursor-core.js');
    CursorApiService = mod.CursorApiService;
});

afterEach(() => {
    // Emit end to trigger heartbeat interval cleanup in cursor-core
    if (mockH2Stream.listenerCount('end') > 0) {
        mockH2Stream.emit('end');
    }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CursorApiService — end-stream error handling', () => {
    let service;

    beforeEach(() => {
        mockH2Stream.removeAllListeners();
        mockH2Stream.closed = false;
        mockH2Stream.destroyed = false;
        mockH2Stream.write.mockClear();
        mockProcessAgentServerMessage.mockReset();

        service = new CursorApiService({
            CURSOR_OAUTH_CREDS_FILE_PATH: './configs/cursor/fake/token.json',
            uuid: 'test-uuid',
        });
        service.isInitialized = true;
        service._tokenStore = { getValidAccessToken: jest.fn(async () => 'mock-token') };
    });

    // ========================================================================
    // Non-streaming: _doH2RequestNonStreaming
    // ========================================================================

    describe('generateContent (non-streaming)', () => {
        test('should reject with error when Cursor returns error in end-stream frame', async () => {
            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('invalid-model', requestBody);

            process.nextTick(() => {
                mockH2Stream.emit('data', buildErrorEndStreamFrame('Error', 'invalid-model'));
            });

            await expect(promise).rejects.toThrow('Model name is not valid: "invalid-model"');
        });

        test('rejected error should have mapped HTTP status (not_found → 404)', async () => {
            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('bad-model', requestBody);

            process.nextTick(() => {
                mockH2Stream.emit('data', buildErrorEndStreamFrame('Error', 'bad-model'));
            });

            try {
                await promise;
                throw new Error('Should have rejected');
            } catch (err) {
                expect(err.status).toBe(404);
            }
        });

        test('should resolve normally when end-stream frame has no error', async () => {
            mockProcessAgentServerMessage.mockImplementation((msgBytes, callbacks) => {
                callbacks.onText('Hello there!');
            });

            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('claude-4-sonnet', requestBody);

            process.nextTick(() => {
                mockH2Stream.emit('data', buildDataFrame('mock-protobuf'));
                mockH2Stream.emit('data', buildNormalEndStreamFrame());
                mockH2Stream.emit('end');
            });

            const result = await promise;
            expect(result.choices[0].message.content).toBe('Hello there!');
            expect(result.object).toBe('chat.completion');
        });

        test('should reject with 502 when end-stream has non-JSON payload', async () => {
            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('claude-4-sonnet', requestBody);

            process.nextTick(() => {
                mockH2Stream.emit('data', buildFrame(CONNECT_END_STREAM_FLAG, 'not-json'));
                mockH2Stream.emit('end');
            });

            try {
                await promise;
                throw new Error('Should have rejected');
            } catch (err) {
                expect(err.status).toBe(502);
            }
        });

        test('should parse error with fallback to error.message when details missing', async () => {
            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('test-model', requestBody);

            const payload = JSON.stringify({
                error: {
                    code: 'internal',
                    message: 'Internal server error',
                },
            });

            process.nextTick(() => {
                mockH2Stream.emit('data', buildFrame(CONNECT_END_STREAM_FLAG, payload));
            });

            await expect(promise).rejects.toThrow('Internal server error');
        });
    });

    // ========================================================================
    // Edge cases
    // ========================================================================

    describe('edge cases', () => {
        test('should handle error frame split across multiple data events', async () => {
            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('bad-model', requestBody);

            const fullFrame = buildErrorEndStreamFrame('Error', 'bad-model');
            const mid = Math.floor(fullFrame.length / 2);

            process.nextTick(() => {
                mockH2Stream.emit('data', fullFrame.subarray(0, mid));
                mockH2Stream.emit('data', fullFrame.subarray(mid));
            });

            await expect(promise).rejects.toThrow('Model name is not valid: "bad-model"');
        });

        test('should handle multiple frames in single data event', async () => {
            mockProcessAgentServerMessage.mockImplementation((msgBytes, callbacks) => {
                callbacks.onText('chunk');
            });

            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('claude-4-sonnet', requestBody);

            process.nextTick(() => {
                const dataFrame = buildDataFrame('proto-data');
                const endFrame = buildNormalEndStreamFrame();
                const combined = Buffer.concat([dataFrame, endFrame]);
                mockH2Stream.emit('data', combined);
                mockH2Stream.emit('end');
            });

            const result = await promise;
            expect(result.choices[0].message.content).toBe('chunk');
        });
    });
});

// ---------------------------------------------------------------------------
// Lifecycle + utility method tests
// ---------------------------------------------------------------------------

describe('CursorApiService — lifecycle & utilities', () => {
    let service;

    beforeEach(() => {
        mockH2Stream.removeAllListeners();
        mockH2Stream.closed = false;
        mockH2Stream.destroyed = false;
        mockH2Stream.write.mockClear();
        mockProcessAgentServerMessage.mockReset();

        service = new CursorApiService({
            CURSOR_OAUTH_CREDS_FILE_PATH: './configs/cursor/fake/token.json',
            uuid: 'test-uuid',
        });
        service.isInitialized = true;
        service._tokenStore = {
            getValidAccessToken: jest.fn(async () => 'mock-token'),
            isExpiryDateNear: jest.fn(() => false),
            _doRefresh: jest.fn().mockResolvedValue(undefined),
        };
    });

    test('isExpiryDateNear returns false when _tokenStore is null', () => {
        service._tokenStore = null;
        expect(service.isExpiryDateNear()).toBe(false);
    });

    test('isExpiryDateNear delegates to tokenStore', () => {
        service._tokenStore.isExpiryDateNear.mockReturnValue(true);
        expect(service.isExpiryDateNear()).toBe(true);
    });

    test('getUsageLimits returns empty object', async () => {
        const result = await service.getUsageLimits();
        expect(result).toEqual({});
    });

    test('refreshToken does not call _doRefresh when token is fresh', async () => {
        service._tokenStore.isExpiryDateNear.mockReturnValue(false);
        await service.refreshToken();
        expect(service._tokenStore._doRefresh).not.toHaveBeenCalled();
    });

    test('refreshToken calls _doRefresh when token is near expiry', async () => {
        service._tokenStore.isExpiryDateNear.mockReturnValue(true);
        await service.refreshToken();
        expect(service._tokenStore._doRefresh).toHaveBeenCalledTimes(1);
    });

    test('forceRefreshToken calls _doRefresh unconditionally', async () => {
        service._tokenStore.isExpiryDateNear.mockReturnValue(false);
        await service.forceRefreshToken();
        expect(service._tokenStore._doRefresh).toHaveBeenCalledTimes(1);
    });

    test('listModels uses cache on second call within TTL', async () => {
        service._fetchUsableModels = jest.fn().mockResolvedValue([
            { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet' },
        ]);
        const r1 = await service.listModels();
        const r2 = await service.listModels();
        expect(service._fetchUsableModels).toHaveBeenCalledTimes(1);
        expect(r1).toBe(r2);
    });

    test('listModels returns fetched models', async () => {
        service._fetchUsableModels = jest.fn().mockResolvedValue([
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'claude-4', name: 'Claude 4' },
        ]);
        const result = await service.listModels();
        expect(result.object).toBe('list');
        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe('gpt-4o');
    });

    test('listModels falls back to static list on error', async () => {
        service._fetchUsableModels = jest.fn().mockRejectedValue(new Error('Network error'));
        const result = await service.listModels();
        expect(result.object).toBe('list');
        expect(result.data.length).toBeGreaterThan(0);
        // Static fallback models should be present
        expect(result.data.some(m => m.id === 'auto')).toBe(true);
    });

    test('listModels uses fallback when _fetchUsableModels returns empty', async () => {
        service._fetchUsableModels = jest.fn().mockResolvedValue([]);
        const result = await service.listModels();
        expect(result.data.some(m => m.id === 'auto')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// generateContentStream tests
// ---------------------------------------------------------------------------

describe('CursorApiService — generateContentStream', () => {
    let service;

    beforeEach(() => {
        mockH2Stream.removeAllListeners();
        mockH2Stream.closed = false;
        mockH2Stream.destroyed = false;
        mockH2Stream.write.mockClear();
        mockProcessAgentServerMessage.mockReset();

        service = new CursorApiService({
            CURSOR_OAUTH_CREDS_FILE_PATH: './configs/cursor/fake/token.json',
            uuid: 'test-uuid',
        });
        service.isInitialized = true;
        service._tokenStore = { getValidAccessToken: jest.fn(async () => 'mock-token') };
    });

    test('yields text chunk and finish chunk on success', async () => {
        mockProcessAgentServerMessage.mockImplementation((msgBytes, callbacks) => {
            callbacks.onText('streamed text');
        });

        const requestBody = { messages: [{ role: 'user', content: 'Hello' }] };
        const gen = service.generateContentStream('claude-4-sonnet', requestBody);

        process.nextTick(() => {
            mockH2Stream.emit('data', buildDataFrame('proto-data'));
            mockH2Stream.emit('data', buildNormalEndStreamFrame());
            mockH2Stream.emit('end');
        });

        const chunks = [];
        for await (const c of gen) {
            chunks.push(c);
        }
        // Should have at least a role chunk, content chunk, and finish chunk
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(chunks.some(c => c.choices?.[0]?.delta?.content === 'streamed text')).toBe(true);
    });

    test('yields error chunk when stream returns error frame', async () => {
        const requestBody = { messages: [{ role: 'user', content: 'Hello' }] };
        const gen = service.generateContentStream('bad-model', requestBody);

        process.nextTick(() => {
            mockH2Stream.emit('data', buildErrorEndStreamFrame('Error', 'bad-model'));
            mockH2Stream.emit('end');
        });

        const chunks = [];
        for await (const c of gen) {
            chunks.push(c);
        }
        // Should yield an error message chunk
        const errorChunk = chunks.find(c => c.choices?.[0]?.delta?.content?.includes('Error'));
        expect(errorChunk).toBeDefined();
    });

    test('throws when no user message provided', async () => {
        const { parseMessages } = await import('../../../../src/providers/cursor/cursor-protobuf.js');
        parseMessages.mockReturnValueOnce({
            systemPrompt: '',
            userText: '',
            images: [],
            turns: [],
            toolResults: [],
        });

        const requestBody = { messages: [] };
        const gen = service.generateContentStream('claude-4-sonnet', requestBody);
        await expect(gen.next()).rejects.toThrow('No user message found');
    });
});
