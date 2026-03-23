/**
 * Unit tests for cursor-protobuf.js
 *
 * Tests: parseMessages, buildCursorAgentRequest, buildHeartbeatBytes,
 *        buildMcpToolDefinitions, buildToolResultFrames
 *
 * Note: frameConnectMessage, parseConnectFrame, CONNECT_END_STREAM_FLAG
 *       are defined in cursor-h2.js and tested in cursor-h2.test.js.
 */

import { describe, test, expect } from '@jest/globals';
import {
    parseMessages,
    buildCursorAgentRequest,
    buildHeartbeatBytes,
    buildMcpToolDefinitions,
    buildToolResultFrames,
} from '../../../../src/providers/cursor/cursor-protobuf.js';

// ============================================================================
// parseMessages
// ============================================================================

describe('parseMessages', () => {
    test('extracts system prompt from system messages', () => {
        const messages = [
            { role: 'system', content: 'You are a coding assistant.' },
            { role: 'user', content: 'Hello' },
        ];
        const result = parseMessages(messages);
        expect(result.systemPrompt).toBe('You are a coding assistant.');
        expect(result.userText).toBe('Hello');
    });

    test('concatenates multiple system messages', () => {
        const messages = [
            { role: 'system', content: 'Line 1' },
            { role: 'system', content: 'Line 2' },
            { role: 'user', content: 'Hi' },
        ];
        const result = parseMessages(messages);
        expect(result.systemPrompt).toBe('Line 1\nLine 2');
    });

    test('uses default system prompt when none provided', () => {
        const messages = [{ role: 'user', content: 'Hello' }];
        const result = parseMessages(messages);
        expect(result.systemPrompt).toBe('You are a helpful assistant.');
    });

    test('extracts user/assistant turn pairs', () => {
        const messages = [
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: 'First answer' },
            { role: 'user', content: 'Second question' },
        ];
        const result = parseMessages(messages);
        expect(result.turns).toHaveLength(1);
        expect(result.turns[0]).toEqual({ userText: 'First question', assistantText: 'First answer' });
        expect(result.userText).toBe('Second question');
    });

    test('handles consecutive user messages', () => {
        const messages = [
            { role: 'user', content: 'Msg1' },
            { role: 'user', content: 'Msg2' },
        ];
        const result = parseMessages(messages);
        expect(result.turns).toHaveLength(1);
        expect(result.turns[0]).toEqual({ userText: 'Msg1', assistantText: '' });
        expect(result.userText).toBe('Msg2');
    });

    test('extracts tool results', () => {
        const messages = [
            { role: 'user', content: 'Use the tool' },
            { role: 'assistant', content: 'I will use the tool' },
            { role: 'tool', tool_call_id: 'call_123', content: 'Tool output here' },
        ];
        const result = parseMessages(messages);
        expect(result.toolResults).toHaveLength(1);
        expect(result.toolResults[0]).toEqual({
            toolCallId: 'call_123',
            content: 'Tool output here',
        });
    });

    test('handles tool result with missing tool_call_id', () => {
        const messages = [
            { role: 'user', content: 'test' },
            { role: 'tool', content: 'result' },
        ];
        const result = parseMessages(messages);
        expect(result.toolResults[0].toolCallId).toBe('');
    });

    test('handles array content with text and image_url', () => {
        const base64Img = 'data:image/png;base64,iVBORw0KGgo=';
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What is in this image?' },
                    { type: 'image_url', image_url: { url: base64Img } },
                ],
            },
        ];
        const result = parseMessages(messages);
        expect(result.userText).toBe('What is in this image?');
        expect(result.images).toHaveLength(1);
        expect(result.images[0].mimeType).toBe('image/png');
        expect(result.images[0].data).toBeInstanceOf(Uint8Array);
    });

    test('ignores http URLs in images (only supports data: URLs)', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Look at this' },
                    { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
                ],
            },
        ];
        const result = parseMessages(messages);
        expect(result.images).toHaveLength(0);
    });

    test('handles empty messages array', () => {
        const result = parseMessages([]);
        expect(result.systemPrompt).toBe('You are a helpful assistant.');
        expect(result.userText).toBe('');
        expect(result.turns).toHaveLength(0);
        expect(result.toolResults).toHaveLength(0);
        expect(result.images).toHaveLength(0);
    });

    test('handles null/undefined content gracefully', () => {
        const messages = [
            { role: 'user', content: null },
        ];
        const result = parseMessages(messages);
        expect(result.userText).toBe('');
    });

    test('handles string array content', () => {
        const messages = [
            { role: 'user', content: ['Part 1', 'Part 2'] },
        ];
        const result = parseMessages(messages);
        expect(result.userText).toBe('Part 1Part 2');
    });

    test('pops last turn as userText when no pending user message', () => {
        const messages = [
            { role: 'user', content: 'Q1' },
            { role: 'assistant', content: 'A1' },
            { role: 'user', content: 'Q2' },
            { role: 'assistant', content: 'A2' },
        ];
        const result = parseMessages(messages);
        // Last pair has no trailing user, so last turn is popped
        expect(result.userText).toBe('Q2');
        expect(result.turns).toHaveLength(1);
    });
});

// ============================================================================
// buildCursorAgentRequest
// ============================================================================

describe('buildCursorAgentRequest', () => {
    test('returns requestBytes, blobStore, and mcpTools', () => {
        const result = buildCursorAgentRequest({
            modelId: 'claude-3.5-sonnet',
            systemPrompt: 'You are helpful.',
            userText: 'Hello',
            images: [],
            turns: [],
            mcpTools: [],
        });

        expect(result.requestBytes).toBeInstanceOf(Uint8Array);
        expect(result.requestBytes.length).toBeGreaterThan(0);
        expect(result.blobStore).toBeInstanceOf(Map);
        expect(result.blobStore.size).toBe(1); // system prompt blob
        expect(result.mcpTools).toEqual([]);
    });

    test('stores system prompt in blobStore as JSON', () => {
        const result = buildCursorAgentRequest({
            modelId: 'gpt-4o',
            systemPrompt: 'Test prompt',
            userText: 'Hi',
            images: [],
            turns: [],
        });

        expect(result.blobStore.size).toBe(1);
        const blobEntry = [...result.blobStore.values()][0];
        const decoded = JSON.parse(new TextDecoder().decode(blobEntry));
        expect(decoded.role).toBe('system');
        expect(decoded.content).toBe('Test prompt');
    });

    test('handles conversation turns', () => {
        const result = buildCursorAgentRequest({
            modelId: 'claude-3.5-sonnet',
            systemPrompt: 'sys',
            userText: 'Current question',
            images: [],
            turns: [
                { userText: 'First Q', assistantText: 'First A' },
                { userText: 'Second Q', assistantText: 'Second A' },
            ],
        });

        expect(result.requestBytes).toBeInstanceOf(Uint8Array);
        expect(result.requestBytes.length).toBeGreaterThan(0);
    });

    test('handles images', () => {
        const imgData = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
        const result = buildCursorAgentRequest({
            modelId: 'gpt-4o',
            systemPrompt: 'sys',
            userText: 'Describe this',
            images: [{ data: imgData, mimeType: 'image/png' }],
            turns: [],
        });

        expect(result.requestBytes.length).toBeGreaterThan(0);
    });
});

// ============================================================================
// buildHeartbeatBytes
// ============================================================================

describe('buildHeartbeatBytes', () => {
    test('returns a framed Connect message', () => {
        const hb = buildHeartbeatBytes();
        expect(Buffer.isBuffer(hb)).toBe(true);
        expect(hb.length).toBeGreaterThan(5); // 5-byte header + payload
        expect(hb[0]).toBe(0); // flags = 0 (regular message)
        const payloadLen = hb.readUInt32BE(1);
        expect(hb.length).toBe(5 + payloadLen);
    });
});

// ============================================================================
// buildMcpToolDefinitions
// ============================================================================

describe('buildMcpToolDefinitions', () => {
    test('converts OpenAI tool format to McpToolDefinition', () => {
        const tools = [
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get current weather',
                    parameters: {
                        type: 'object',
                        properties: { city: { type: 'string' } },
                        required: ['city'],
                    },
                },
            },
        ];
        const result = buildMcpToolDefinitions(tools);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('get_weather');
        expect(result[0].description).toBe('Get current weather');
    });

    test('handles empty tools array', () => {
        expect(buildMcpToolDefinitions([])).toHaveLength(0);
    });

    test('handles null/undefined tools', () => {
        expect(buildMcpToolDefinitions(null)).toHaveLength(0);
        expect(buildMcpToolDefinitions(undefined)).toHaveLength(0);
    });

    test('handles tool without parameters', () => {
        const tools = [
            { type: 'function', function: { name: 'no_params', description: '' } },
        ];
        const result = buildMcpToolDefinitions(tools);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('no_params');
    });
});

// ============================================================================
// buildToolResultFrames
// ============================================================================

describe('buildToolResultFrames', () => {
    test('builds one frame per pending exec', () => {
        const pendingExecs = [
            { execId: 1, execMsgId: 101, toolCallId: 'tc1', toolName: 'get_weather', decodedArgs: '{}' },
            { execId: 2, execMsgId: 102, toolCallId: 'tc2', toolName: 'search', decodedArgs: '{}' },
        ];
        const toolResults = [
            { toolCallId: 'tc1', content: 'Sunny, 25°C' },
            { toolCallId: 'tc2', content: 'Found 3 results' },
        ];
        const frames = buildToolResultFrames(pendingExecs, toolResults);
        expect(frames).toHaveLength(2);
        frames.forEach((f) => {
            expect(Buffer.isBuffer(f)).toBe(true);
            expect(f.length).toBeGreaterThan(5);
        });
    });

    test('handles missing tool result (sends error frame)', () => {
        const pendingExecs = [
            { execId: 3, execMsgId: 103, toolCallId: 'tc1', toolName: 'missing_tool', decodedArgs: '{}' },
        ];
        const toolResults = []; // no matching result
        const frames = buildToolResultFrames(pendingExecs, toolResults);
        expect(frames).toHaveLength(1);
        expect(Buffer.isBuffer(frames[0])).toBe(true);
    });

    test('returns empty array for empty pending execs', () => {
        const frames = buildToolResultFrames([], []);
        expect(frames).toHaveLength(0);
    });
});
