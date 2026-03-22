/**
 * Unit tests for cursor-core.js
 *
 * Tests: end-stream error handling in non-streaming and streaming paths,
 *        ensuring Cursor API errors are properly surfaced instead of
 *        silently returning empty content.
 */

import { EventEmitter } from 'node:events';
import { CONNECT_END_STREAM_FLAG } from '../../src/providers/cursor/cursor-protobuf.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock logger
jest.mock('../../src/utils/logger.js', () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    return { __esModule: true, default: logger };
});

// Mock cursor-token-store
jest.mock('../../src/providers/cursor/cursor-token-store.js', () => ({
    CursorTokenStore: jest.fn().mockImplementation(() => ({
        initialize: jest.fn(),
        getValidAccessToken: jest.fn().mockResolvedValue('mock-token'),
        isExpiryDateNear: jest.fn().mockReturnValue(false),
    })),
}));

// Mock cursor-session
jest.mock('../../src/providers/cursor/cursor-session.js', () => ({
    deriveSessionKey: jest.fn().mockReturnValue('session-key'),
    getSession: jest.fn().mockReturnValue(null),
    removeSession: jest.fn(),
    saveSession: jest.fn(),
    cleanupSession: jest.fn(),
}));

// We need a controllable fake H2 stream
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

// Mock h2RequestStream
const mockH2Stream = createMockH2Stream();
const mockH2Client = createMockH2Client();

jest.mock('../../src/providers/cursor/cursor-h2.js', () => ({
    h2RequestStream: jest.fn().mockReturnValue({
        client: mockH2Client,
        stream: mockH2Stream,
    }),
}));

// Mock protobuf functions (keep CONNECT_END_STREAM_FLAG real)
jest.mock('../../src/providers/cursor/cursor-protobuf.js', () => {
    const actual = jest.requireActual('../../src/providers/cursor/cursor-protobuf.js');
    return {
        ...actual,
        parseMessages: jest.fn().mockReturnValue({
            systemPrompt: 'You are a helpful assistant.',
            userText: 'Hello',
            images: [],
            turns: [],
            toolResults: [],
        }),
        buildCursorAgentRequest: jest.fn().mockReturnValue({
            requestBytes: Buffer.from('mock-request'),
            blobStore: new Map(),
        }),
        buildHeartbeatBytes: jest.fn().mockReturnValue(Buffer.from('heartbeat')),
        buildMcpToolDefinitions: jest.fn().mockReturnValue([]),
        frameConnectMessage: jest.fn().mockReturnValue(Buffer.from('framed')),
        processAgentServerMessage: jest.fn(),
    };
});

// Mock protobuf runtime (agent_pb.js)
jest.mock('../../src/providers/cursor/proto/agent_pb.js', () => ({
    GetUsableModelsRequestSchema: {},
    GetUsableModelsResponseSchema: {},
}));

jest.mock('@bufbuild/protobuf', () => ({
    create: jest.fn(),
    fromBinary: jest.fn(),
    toBinary: jest.fn().mockReturnValue(Buffer.from('mock')),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a binary frame with the given flags and JSON payload.
 * Format: [flags:1byte][length:4bytes BE][payload]
 */
function buildFrame(flags, payload) {
    const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(payloadBuf.length, 1);
    return Buffer.concat([header, payloadBuf]);
}

/** Build a Cursor-style error end-stream frame */
function buildErrorEndStreamFrame(errorMessage, modelName) {
    const payload = JSON.stringify({
        error: {
            code: 'not_found',
            message: 'Error',
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

/** Build a normal end-stream frame (no error) */
function buildNormalEndStreamFrame() {
    return buildFrame(CONNECT_END_STREAM_FLAG, '{}');
}

/** Build a normal data frame (flags=0) */
function buildDataFrame(payload) {
    return buildFrame(0x00, payload || 'mock-protobuf-data');
}

// ---------------------------------------------------------------------------
// Import CursorApiService after mocks
// ---------------------------------------------------------------------------

let CursorApiService;

beforeAll(async () => {
    const mod = await import('../../src/providers/cursor/cursor-core.js');
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
        // Reset stream state
        mockH2Stream.removeAllListeners();
        mockH2Stream.closed = false;
        mockH2Stream.destroyed = false;
        mockH2Stream.write.mockClear();
        mockH2Client.close.mockClear();

        // Re-wire mock so each test gets fresh listeners
        const { h2RequestStream } = require('../../src/providers/cursor/cursor-h2.js');
        h2RequestStream.mockReturnValue({
            client: createMockH2Client(),
            stream: mockH2Stream,
        });

        service = new CursorApiService({
            CURSOR_OAUTH_CREDS_FILE_PATH: './configs/cursor/fake/token.json',
            uuid: 'test-uuid',
        });
        // Mark as initialized
        service._initialized = true;
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

            // Simulate Cursor returning an error end-stream frame
            process.nextTick(() => {
                const errorFrame = buildErrorEndStreamFrame(
                    'Error',
                    'invalid-model',
                );
                mockH2Stream.emit('data', errorFrame);
            });

            await expect(promise).rejects.toThrow('Model name is not valid: "invalid-model"');
        });

        test('rejected error should have status 400', async () => {
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
                expect(err.status).toBe(400);
            }
        });

        test('should resolve normally when end-stream frame has no error', async () => {
            const { processAgentServerMessage } = require('../../src/providers/cursor/cursor-protobuf.js');
            processAgentServerMessage.mockImplementation((msgBytes, callbacks) => {
                callbacks.onText('Hello there!');
            });

            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('claude-4-sonnet', requestBody);

            process.nextTick(() => {
                // Send a data frame first (triggers onText)
                mockH2Stream.emit('data', buildDataFrame('mock-protobuf'));
                // Then send normal end-stream and close
                mockH2Stream.emit('data', buildNormalEndStreamFrame());
                mockH2Stream.emit('end');
            });

            const result = await promise;
            expect(result.choices[0].message.content).toBe('Hello there!');
            expect(result.object).toBe('chat.completion');
        });

        test('should return empty content when end-stream has non-JSON payload', async () => {
            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('claude-4-sonnet', requestBody);

            process.nextTick(() => {
                // End stream with non-JSON (should not throw, just continue)
                mockH2Stream.emit('data', buildFrame(CONNECT_END_STREAM_FLAG, 'not-json'));
                mockH2Stream.emit('end');
            });

            const result = await promise;
            expect(result.choices[0].message.content).toBe('');
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
                // Send frame in two parts
                mockH2Stream.emit('data', fullFrame.subarray(0, mid));
                mockH2Stream.emit('data', fullFrame.subarray(mid));
            });

            await expect(promise).rejects.toThrow('Model name is not valid: "bad-model"');
        });

        test('should handle multiple frames in single data event', async () => {
            const { processAgentServerMessage } = require('../../src/providers/cursor/cursor-protobuf.js');
            processAgentServerMessage.mockImplementation((msgBytes, callbacks) => {
                callbacks.onText('chunk');
            });

            const requestBody = {
                messages: [{ role: 'user', content: 'Hello' }],
            };

            const promise = service.generateContent('claude-4-sonnet', requestBody);

            process.nextTick(() => {
                // Combine data frame + end-stream frame in one event
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
