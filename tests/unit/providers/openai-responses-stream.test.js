/**
 * Unit tests for src/providers/openai/openai-responses-stream.js
 * Tests: StreamState, streamStateManager, all generate* functions
 */

import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

let streamStateManager;
let generateResponseCreated;
let generateResponseInProgress;
let generateOutputItemAdded;
let generateContentPartAdded;
let generateOutputTextDelta;
let generateOutputTextDone;
let generateContentPartDone;
let generateOutputItemDone;
let generateResponseCompleted;

beforeAll(async () => {
    await jest.unstable_mockModule('uuid', () => ({
        __esModule: true,
        v4: jest.fn(() => 'mock-uuid-1234-5678-abcd'),
    }));

    const mod = await import('../../../src/providers/openai/openai-responses-stream.js');
    streamStateManager = mod.streamStateManager;
    generateResponseCreated = mod.generateResponseCreated;
    generateResponseInProgress = mod.generateResponseInProgress;
    generateOutputItemAdded = mod.generateOutputItemAdded;
    generateContentPartAdded = mod.generateContentPartAdded;
    generateOutputTextDelta = mod.generateOutputTextDelta;
    generateOutputTextDone = mod.generateOutputTextDone;
    generateContentPartDone = mod.generateContentPartDone;
    generateOutputItemDone = mod.generateOutputItemDone;
    generateResponseCompleted = mod.generateResponseCompleted;
});

beforeEach(() => {
    // Clean up state between tests by clearing all tracked states
    streamStateManager.states.clear();
});

describe('streamStateManager', () => {
    describe('getOrCreateState()', () => {
        test('creates a new state for a new requestId', () => {
            const state = streamStateManager.getOrCreateState('req-001');
            expect(state).toBeDefined();
            expect(state.id).toMatch(/^resp_/);
            expect(state.msgId).toMatch(/^msg_/);
            expect(state.fullText).toBe('');
            expect(state.sequenceNumber).toBe(0);
            expect(state.status).toBe('in_progress');
        });

        test('returns same state for the same requestId', () => {
            const s1 = streamStateManager.getOrCreateState('req-002');
            const s2 = streamStateManager.getOrCreateState('req-002');
            expect(s1).toBe(s2);
        });
    });

    describe('updateText()', () => {
        test('appends delta to fullText and increments sequenceNumber', () => {
            streamStateManager.getOrCreateState('req-003');
            streamStateManager.updateText('req-003', 'hello ');
            const state = streamStateManager.updateText('req-003', 'world');
            expect(state.fullText).toBe('hello world');
            expect(state.sequenceNumber).toBe(2);
        });
    });

    describe('setModel()', () => {
        test('sets the model field', () => {
            const state = streamStateManager.setModel('req-004', 'gpt-4o');
            expect(state.model).toBe('gpt-4o');
        });
    });

    describe('completeRequest()', () => {
        test('sets status to completed', () => {
            streamStateManager.getOrCreateState('req-005');
            const state = streamStateManager.completeRequest('req-005');
            expect(state.status).toBe('completed');
        });
    });

    describe('cleanup()', () => {
        test('removes state for given requestId', () => {
            streamStateManager.getOrCreateState('req-006');
            expect(streamStateManager.states.has('req-006')).toBe(true);
            streamStateManager.cleanup('req-006');
            expect(streamStateManager.states.has('req-006')).toBe(false);
        });
    });
});

describe('generateResponseCreated()', () => {
    test('returns event with type response.created', () => {
        const event = generateResponseCreated('req-10', 'gpt-4o');
        expect(event.type).toBe('response.created');
        expect(event.response).toBeDefined();
        expect(event.response.status).toBe('in_progress');
        expect(event.response.model).toBe('gpt-4o');
    });

    test('uses default model when not specified', () => {
        const event = generateResponseCreated('req-11');
        expect(event.response.model).toBeDefined();
    });
});

describe('generateResponseInProgress()', () => {
    test('returns event with type response.in_progress', () => {
        const event = generateResponseInProgress('req-12');
        expect(event.type).toBe('response.in_progress');
        expect(event.response.status).toBe('in_progress');
    });
});

describe('generateOutputItemAdded()', () => {
    test('returns event with type response.output_item.added', () => {
        const event = generateOutputItemAdded('req-13');
        expect(event.type).toBe('response.output_item.added');
        expect(event.item.role).toBe('assistant');
        expect(event.item.type).toBe('message');
    });
});

describe('generateContentPartAdded()', () => {
    test('returns event with type response.content_part.added', () => {
        const event = generateContentPartAdded('req-14');
        expect(event.type).toBe('response.content_part.added');
        expect(event.part.type).toBe('output_text');
        expect(event.part.text).toBe('');
    });
});

describe('generateOutputTextDelta()', () => {
    test('returns delta event with the provided text chunk', () => {
        const event = generateOutputTextDelta('req-15', 'chunk text');
        expect(event.type).toBe('response.output_text.delta');
        expect(event.delta).toBe('chunk text');
    });

    test('accumulates text in state', () => {
        generateOutputTextDelta('req-16', 'part1 ');
        generateOutputTextDelta('req-16', 'part2');
        const state = streamStateManager.getOrCreateState('req-16');
        expect(state.fullText).toBe('part1 part2');
    });
});

describe('generateOutputTextDone()', () => {
    test('returns event with accumulated fullText', () => {
        streamStateManager.updateText('req-17', 'full response');
        const event = generateOutputTextDone('req-17');
        expect(event.type).toBe('response.output_text.done');
        expect(event.text).toBe('full response');
    });
});

describe('generateContentPartDone()', () => {
    test('returns content_part.done event with full text', () => {
        streamStateManager.updateText('req-18', 'complete text');
        const event = generateContentPartDone('req-18');
        expect(event.type).toBe('response.content_part.done');
        expect(event.part.text).toBe('complete text');
    });
});

describe('generateOutputItemDone()', () => {
    test('returns output_item.done event with completed status', () => {
        streamStateManager.updateText('req-19', 'item content');
        const event = generateOutputItemDone('req-19');
        expect(event.type).toBe('response.output_item.done');
        expect(event.item.status).toBe('completed');
        expect(event.item.content[0].text).toBe('item content');
    });
});

describe('generateResponseCompleted()', () => {
    test('returns response.completed event', () => {
        streamStateManager.updateText('req-20', 'final text');
        const event = generateResponseCompleted('req-20');
        expect(event.type).toBe('response.completed');
        expect(event.response.status).toBe('completed');
        expect(event.response.output[0].content[0].text).toBe('final text');
    });

    test('uses provided usage object', () => {
        const usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30 };
        const event = generateResponseCompleted('req-21', usage);
        expect(event.response.usage).toEqual(usage);
    });

    test('generates random usage when not provided', () => {
        const event = generateResponseCompleted('req-22');
        expect(event.response.usage).toBeDefined();
        expect(event.response.usage.input_tokens).toBeGreaterThan(0);
    });
});
