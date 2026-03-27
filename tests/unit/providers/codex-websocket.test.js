import {
    buildWebSocketUrl,
    buildWebSocketRequestBody,
    parseWebSocketError,
    normalizeCompletion,
    CodexWebSocketSessionManager,
} from '../../../src/providers/openai/codex-websocket.js';

describe('codex-websocket', () => {
    describe('buildWebSocketUrl', () => {
        it('should convert https to wss', () => {
            expect(buildWebSocketUrl('https://chatgpt.com/backend-api/codex/responses'))
                .toBe('wss://chatgpt.com/backend-api/codex/responses');
        });

        it('should convert http to ws', () => {
            expect(buildWebSocketUrl('http://localhost:3000/responses'))
                .toBe('ws://localhost:3000/responses');
        });

        it('should preserve path and query params', () => {
            const result = buildWebSocketUrl('https://example.com/api?key=value');
            expect(result).toBe('wss://example.com/api?key=value');
        });
    });

    describe('buildWebSocketRequestBody', () => {
        it('should add type: response.create', () => {
            const body = { model: 'gpt-5', input: [{ role: 'user', content: 'hi' }] };
            const result = buildWebSocketRequestBody(body);
            expect(result.type).toBe('response.create');
            expect(result.model).toBe('gpt-5');
            expect(result.input).toEqual(body.input);
        });

        it('should return null for null input', () => {
            expect(buildWebSocketRequestBody(null)).toBeNull();
        });

        it('should not mutate the original body', () => {
            const body = { model: 'gpt-5' };
            const result = buildWebSocketRequestBody(body);
            expect(body.type).toBeUndefined();
            expect(result.type).toBe('response.create');
        });
    });

    describe('parseWebSocketError', () => {
        it('should detect error messages', () => {
            const msg = JSON.stringify({
                type: 'error',
                status: 429,
                error: { type: 'rate_limit', message: 'Too many requests' }
            });
            const result = parseWebSocketError(msg);
            expect(result.isError).toBe(true);
            expect(result.status).toBe(429);
        });

        it('should return isError false for non-error messages', () => {
            const msg = JSON.stringify({ type: 'response.output_item.added', item: {} });
            const result = parseWebSocketError(msg);
            expect(result.isError).toBe(false);
        });

        it('should handle invalid JSON gracefully', () => {
            const result = parseWebSocketError('not json');
            expect(result.isError).toBe(false);
        });

        it('should handle error without status', () => {
            const msg = JSON.stringify({ type: 'error', error: { message: 'bad' } });
            const result = parseWebSocketError(msg);
            expect(result.isError).toBe(false); // no valid status
        });

        it('should use status_code fallback', () => {
            const msg = JSON.stringify({
                type: 'error',
                status_code: 503,
                error: { type: 'service_unavailable', message: 'down' }
            });
            const result = parseWebSocketError(msg);
            expect(result.isError).toBe(true);
            expect(result.status).toBe(503);
        });

        it('should generate default error body if no error field', () => {
            const msg = JSON.stringify({ type: 'error', status: 500 });
            const result = parseWebSocketError(msg);
            expect(result.isError).toBe(true);
            const parsed = JSON.parse(result.payload);
            expect(parsed.error.type).toBe('server_error');
        });
    });

    describe('normalizeCompletion', () => {
        it('should convert response.done to response.completed', () => {
            const input = JSON.stringify({ type: 'response.done', response: { id: '123' } });
            const result = JSON.parse(normalizeCompletion(input));
            expect(result.type).toBe('response.completed');
            expect(result.response.id).toBe('123');
        });

        it('should leave response.completed unchanged', () => {
            const input = JSON.stringify({ type: 'response.completed' });
            const result = JSON.parse(normalizeCompletion(input));
            expect(result.type).toBe('response.completed');
        });

        it('should leave other event types unchanged', () => {
            const input = JSON.stringify({ type: 'response.output_item.added' });
            const result = JSON.parse(normalizeCompletion(input));
            expect(result.type).toBe('response.output_item.added');
        });

        it('should handle invalid JSON gracefully', () => {
            expect(normalizeCompletion('not json')).toBe('not json');
        });
    });

    describe('CodexWebSocketSessionManager', () => {
        let manager;

        beforeEach(() => {
            manager = new CodexWebSocketSessionManager();
        });

        it('should create new sessions', () => {
            const session = manager.getOrCreate('session-1');
            expect(session).toBeTruthy();
            expect(session.sessionId).toBe('session-1');
        });

        it('should return existing session', () => {
            const s1 = manager.getOrCreate('session-1');
            const s2 = manager.getOrCreate('session-1');
            expect(s1).toBe(s2);
        });

        it('should return null for empty sessionId', () => {
            expect(manager.getOrCreate('')).toBeNull();
            expect(manager.getOrCreate(null)).toBeNull();
        });

        it('should close specific session', () => {
            manager.getOrCreate('session-1');
            manager.getOrCreate('session-2');
            manager.close('session-1');
            expect(manager.sessions.size).toBe(1);
            expect(manager.sessions.has('session-2')).toBe(true);
        });

        it('should close all sessions', () => {
            manager.getOrCreate('session-1');
            manager.getOrCreate('session-2');
            manager.closeAll();
            expect(manager.sessions.size).toBe(0);
        });
    });
});
