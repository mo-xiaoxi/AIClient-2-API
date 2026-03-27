/**
 * Unit tests for cursor-degenerate detection functions.
 *
 * Tests:
 *   - checkDegenerateLoop: short token repeat detection
 *   - checkDegenerateLoop: normal output no false positive
 *   - checkDegenerateLoop: HTML token cross-chunk splicing detection
 *   - checkToolCallLoop: depth over limit returns true
 *   - checkToolCallLoop: 3 consecutive same tool+args returns true
 *   - checkToolCallLoop: different tools no false positive
 *
 * ESM: jest.unstable_mockModule + dynamic import
 */

import { jest, describe, test, expect, beforeAll } from '@jest/globals';

let checkDegenerateLoop;
let checkToolCallLoop;

beforeAll(async () => {
    // Mock logger to avoid real I/O
    await jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    // Mock all cursor-core dependencies so we can just get the exported functions
    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-token-store.js', () => ({
        CursorTokenStore: jest.fn().mockImplementation(() => ({
            initialize: jest.fn(),
            getValidAccessToken: jest.fn(async () => 'mock-token'),
            isExpiryDateNear: jest.fn(() => false),
        })),
    }));

    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-session.js', () => ({
        deriveSessionKey: jest.fn(() => 'session-key'),
        getSession: jest.fn(() => null),
        removeSession: jest.fn(),
        saveSession: jest.fn(),
        cleanupSession: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-h2.js', () => ({
        CONNECT_END_STREAM_FLAG: 0x02,
        frameConnectMessage: jest.fn(() => Buffer.from('framed')),
        parseConnectErrorFrame: jest.fn(() => null),
        h2RequestStream: jest.fn(() => ({
            client: { close: jest.fn() },
            stream: { on: jest.fn(), write: jest.fn(), closed: false, destroyed: false },
        })),
    }));

    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-truncation.js', () => ({
        isTruncated: jest.fn(() => false),
        autoContinueFull: jest.fn(),
        autoContinueStream: jest.fn(),
    }));

    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-compression.js', () => ({
        compressMessages: jest.fn((msgs) => msgs),
    }));

    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-stream-guard.js', () => ({
        createStreamGuard: jest.fn(() => ({
            push: jest.fn((text) => text),
            finish: jest.fn(() => ''),
            hasUnlocked: jest.fn(() => true),
        })),
    }));

    await jest.unstable_mockModule('../../../../src/providers/cursor/cursor-protobuf.js', () => ({
        parseMessages: jest.fn(() => ({
            systemPrompt: '',
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
        processAgentServerMessage: jest.fn(),
        buildToolResultFrames: jest.fn(() => []),
    }));

    await jest.unstable_mockModule('../../../../src/providers/cursor/proto/agent_pb.js', () => ({
        GetUsableModelsRequestSchema: {},
        GetUsableModelsResponseSchema: {},
    }));

    await jest.unstable_mockModule('@bufbuild/protobuf', () => ({
        create: jest.fn(),
        fromBinary: jest.fn(),
        toBinary: jest.fn(() => Buffer.from('mock')),
    }));

    const mod = await import('../../../../src/providers/cursor/cursor-core.js');
    checkDegenerateLoop = mod.checkDegenerateLoop;
    checkToolCallLoop = mod.checkToolCallLoop;
});

// ============================================================================
// checkDegenerateLoop
// ============================================================================

describe('checkDegenerateLoop', () => {
    function makeState() {
        return {
            lastDelta: '',
            repeatCount: 0,
            tagBuffer: '',
            aborted: false,
        };
    }

    test('short token repeated 8 times returns true', () => {
        const state = makeState();
        const config = {};
        const token = 'hello';

        // First 7 repetitions should not trigger
        for (let i = 0; i < 7; i++) {
            const result = checkDegenerateLoop(token, state, config);
            expect(result).toBe(false);
        }

        // 8th repetition should trigger
        const result = checkDegenerateLoop(token, state, config);
        expect(result).toBe(true);
    });

    test('normal varied output does not trigger false positive', () => {
        const state = makeState();
        const config = {};
        const tokens = ['Hello', ' world', '! How', ' are', ' you', ' doing', ' today', '? I', ' am', ' fine'];

        for (const token of tokens) {
            const result = checkDegenerateLoop(token, state, config);
            expect(result).toBe(false);
        }
    });

    test('repeat count resets when token changes', () => {
        const state = makeState();
        const config = {};

        // Repeat 'foo' 5 times
        for (let i = 0; i < 5; i++) {
            checkDegenerateLoop('foo', state, config);
        }
        expect(state.repeatCount).toBe(5);

        // Switch to different token — count should reset
        checkDegenerateLoop('bar', state, config);
        expect(state.repeatCount).toBe(1);
    });

    test('long token (>20 chars) does not count as short token repeat', () => {
        const state = makeState();
        const config = {};
        const longToken = 'this is a very long token that exceeds twenty characters';

        // Repeat many times — should never trigger
        for (let i = 0; i < 15; i++) {
            const result = checkDegenerateLoop(longToken, state, config);
            expect(result).toBe(false);
        }
    });

    test('custom threshold via config overrides default', () => {
        const state = makeState();
        const config = { maxRepeatTokens: 3 };
        const token = 'hi';

        // First 2 should not trigger
        expect(checkDegenerateLoop(token, state, config)).toBe(false);
        expect(checkDegenerateLoop(token, state, config)).toBe(false);

        // 3rd should trigger
        expect(checkDegenerateLoop(token, state, config)).toBe(true);
    });

    test('HTML token cross-chunk splicing detection — <br> assembled', () => {
        const state = makeState();
        const config = {};

        // Send partial HTML token across multiple calls
        expect(checkDegenerateLoop('<', state, config)).toBe(false);
        expect(checkDegenerateLoop('br', state, config)).toBe(false);
        // Completing the <br> tag — now tagBuffer should have the full token
        // After accumulating a complete HTML token repeatedly, it should detect
        const result = checkDegenerateLoop('>', state, config);
        // State should have attempted to track the HTML token
        // The function should not falsely trigger on first complete HTML token
        expect(result).toBe(false);
    });

    test('HTML token cross-chunk: repeated complete HTML tokens trigger detection', () => {
        const state = makeState();
        const config = { maxRepeatTokens: 3 };

        // Simulate receiving <br> as a complete token, repeated
        expect(checkDegenerateLoop('<br>', state, config)).toBe(false);
        expect(checkDegenerateLoop('<br>', state, config)).toBe(false);
        expect(checkDegenerateLoop('<br>', state, config)).toBe(true);
    });

    test('empty string does not crash and returns false', () => {
        const state = makeState();
        const config = {};
        expect(checkDegenerateLoop('', state, config)).toBe(false);
    });
});

// ============================================================================
// checkToolCallLoop
// ============================================================================

describe('checkToolCallLoop', () => {
    function makeState() {
        return {
            toolCallDepth: 0,
            toolCallHistory: [],
            aborted: false,
        };
    }

    function makeExec(toolName, decodedArgs) {
        return {
            toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
            toolName,
            decodedArgs: typeof decodedArgs === 'string' ? decodedArgs : JSON.stringify(decodedArgs),
        };
    }

    test('depth exceeding limit returns true', () => {
        const state = makeState();
        const config = { maxToolCallDepth: 10 };

        // Call 10 different tools to reach the limit
        for (let i = 0; i < 9; i++) {
            const result = checkToolCallLoop(makeExec(`tool_${i}`, { index: i }), state, config);
            expect(result).toBe(false);
        }

        // 10th call should trigger
        const result = checkToolCallLoop(makeExec('tool_10', { index: 10 }), state, config);
        expect(result).toBe(true);
    });

    test('3 consecutive same tool + same args returns true', () => {
        const state = makeState();
        const config = {};

        const exec = makeExec('read_file', { path: '/tmp/test.txt' });

        // First two same calls should not trigger
        expect(checkToolCallLoop({ ...exec }, state, config)).toBe(false);
        expect(checkToolCallLoop({ ...exec }, state, config)).toBe(false);

        // Third consecutive same call should trigger
        expect(checkToolCallLoop({ ...exec }, state, config)).toBe(true);
    });

    test('different tools do not trigger false positive', () => {
        const state = makeState();
        const config = {};

        expect(checkToolCallLoop(makeExec('read_file', { path: '/a.txt' }), state, config)).toBe(false);
        expect(checkToolCallLoop(makeExec('write_file', { path: '/b.txt' }), state, config)).toBe(false);
        expect(checkToolCallLoop(makeExec('list_dir', { path: '/' }), state, config)).toBe(false);
        expect(checkToolCallLoop(makeExec('read_file', { path: '/a.txt' }), state, config)).toBe(false);
    });

    test('same tool but different args does not trigger 3-consecutive check', () => {
        const state = makeState();
        const config = {};

        expect(checkToolCallLoop(makeExec('read_file', { path: '/a.txt' }), state, config)).toBe(false);
        expect(checkToolCallLoop(makeExec('read_file', { path: '/b.txt' }), state, config)).toBe(false);
        expect(checkToolCallLoop(makeExec('read_file', { path: '/c.txt' }), state, config)).toBe(false);
    });

    test('custom max depth via config', () => {
        const state = makeState();
        const config = { maxToolCallDepth: 3 };

        expect(checkToolCallLoop(makeExec('tool_a', {}), state, config)).toBe(false);
        expect(checkToolCallLoop(makeExec('tool_b', {}), state, config)).toBe(false);
        // 3rd call hits the limit
        expect(checkToolCallLoop(makeExec('tool_c', {}), state, config)).toBe(true);
    });

    test('depth counter increments on each call', () => {
        const state = makeState();
        const config = { maxToolCallDepth: 100 };

        checkToolCallLoop(makeExec('tool_a', {}), state, config);
        expect(state.toolCallDepth).toBe(1);

        checkToolCallLoop(makeExec('tool_b', {}), state, config);
        expect(state.toolCallDepth).toBe(2);
    });
});
