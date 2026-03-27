/**
 * Tests for cursor-vision.js
 *
 * ESM: jest.unstable_mockModule + dynamic import
 *
 * Note: tesseract.js is an optional dependency imported dynamically at runtime.
 * OCR tests are skipped if tesseract.js is not installed — focus on
 * preprocessing logic, SVG handling, API mode, and disabled-by-default behavior.
 */

import { jest, describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';

let mockLogger;

beforeAll(async () => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    await jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
        __esModule: true,
        default: mockLogger,
    }));
});

// ============================================================================
// Tests — disabled by default
// ============================================================================

describe('preprocessImages — disabled (default)', () => {
    let preprocessImages;

    beforeAll(async () => {
        delete process.env.CURSOR_VISION_ENABLED;
        const mod = await import('../../../../src/providers/cursor/cursor-vision.js');
        preprocessImages = mod.preprocessImages;
    });

    test('returns original messages when disabled', async () => {
        const messages = [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
        ];
        const result = await preprocessImages(messages);
        expect(result).toBe(messages);
    });

    test('returns original for null/empty input', async () => {
        expect(await preprocessImages(null)).toBeNull();
        expect(await preprocessImages([])).toEqual([]);
    });
});

// ============================================================================
// Tests — enabled, API mode (no tesseract.js needed)
// ============================================================================

describe('preprocessImages — enabled (api mode)', () => {
    let preprocessImages;
    let mockFetch;

    beforeAll(async () => {
        process.env.CURSOR_VISION_ENABLED = 'true';
        process.env.CURSOR_VISION_MODE = 'api';
        process.env.CURSOR_VISION_API_KEY = 'test-key';

        jest.resetModules();

        await jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger,
        }));

        mockFetch = jest.fn();
        global.fetch = mockFetch;

        const mod = await import('../../../../src/providers/cursor/cursor-vision.js?api');
        preprocessImages = mod.preprocessImages;
    });

    afterAll(() => {
        delete process.env.CURSOR_VISION_ENABLED;
        delete process.env.CURSOR_VISION_MODE;
        delete process.env.CURSOR_VISION_API_KEY;
    });

    beforeEach(() => {
        mockFetch.mockReset();
    });

    test('returns original when no images in messages', async () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ];
        const result = await preprocessImages(messages);
        expect(result).toBe(messages);
    });

    test('returns original when user content is string (not array)', async () => {
        const messages = [{ role: 'user', content: 'just text' }];
        const result = await preprocessImages(messages);
        expect(result).toBe(messages);
    });

    test('replaces SVG images with placeholder text', async () => {
        const messages = [
            { role: 'user', content: [
                { type: 'text', text: 'Look at this' },
                { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,abc' } },
            ]},
        ];
        const result = await preprocessImages(messages);
        expect(result).not.toBe(messages);
        const content = result[result.length - 1].content;
        expect(content[0]).toEqual({ type: 'text', text: 'Look at this' });
        expect(content[1].text).toContain('SVG vector image');
        // No fetch call for SVG
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test('calls Vision API for image_url parts', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'A screenshot showing code editor' } }],
            }),
        });

        const messages = [
            { role: 'user', content: [
                { type: 'text', text: 'Describe this' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
            ]},
        ];
        const result = await preprocessImages(messages);
        const content = result[0].content;
        // Original text preserved
        expect(content[0]).toEqual({ type: 'text', text: 'Describe this' });
        // API description appended
        const descPart = content.find(p => p.text?.includes('image(s)'));
        expect(descPart.text).toContain('A screenshot showing code editor');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('handles Vision API error gracefully', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 429,
            text: async () => 'Rate limited',
        });

        const messages = [
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ]},
        ];
        const result = await preprocessImages(messages);
        const content = result[0].content;
        const errPart = content.find(p => p.text?.includes('failed to process'));
        expect(errPart).toBeDefined();
    });

    test('only processes last user message', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'image desc' } }],
            }),
        });

        const messages = [
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,old' } },
            ]},
            { role: 'assistant', content: 'I see the image' },
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,new' } },
            ]},
        ];
        const result = await preprocessImages(messages);
        // First message untouched
        expect(result[0]).toBe(messages[0]);
        // Last message processed
        expect(result[2]).not.toBe(messages[2]);
    });

    test('handles image type (not just image_url)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'a photo' } }],
            }),
        });

        const messages = [
            { role: 'user', content: [
                { type: 'image', image: 'data:image/jpeg;base64,abc' },
            ]},
        ];
        const result = await preprocessImages(messages);
        const content = result[0].content;
        const descPart = content.find(p => p.text?.includes('image(s)'));
        expect(descPart).toBeDefined();
    });

    test('does not mutate original messages array', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'desc' } }],
            }),
        });

        const original = [
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ]},
        ];
        const originalContent = original[0].content;
        await preprocessImages(original);
        expect(original[0].content).toBe(originalContent);
    });

    test('SVG with .svg URL extension is detected', async () => {
        const messages = [
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: 'https://example.com/logo.svg' } },
            ]},
        ];
        const result = await preprocessImages(messages);
        const content = result[0].content;
        expect(content[0].text).toContain('SVG vector image');
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
