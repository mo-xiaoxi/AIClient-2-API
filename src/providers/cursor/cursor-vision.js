/**
 * cursor-vision.js
 *
 * Image OCR/Vision API fallback for Cursor provider.
 * Preprocesses OpenAI-format messages: replaces image_url content parts
 * with text descriptions via local OCR (tesseract.js) or external Vision API.
 *
 * Disabled by default (CURSOR_VISION_ENABLED=true to enable).
 */

import logger from '../../utils/logger.js';

// Env-driven config
const VISION_ENABLED = process.env.CURSOR_VISION_ENABLED === 'true';
const VISION_MODE = process.env.CURSOR_VISION_MODE || 'ocr'; // 'ocr' | 'api'
const VISION_API_BASE = process.env.CURSOR_VISION_API_BASE || 'https://api.openai.com/v1/chat/completions';
const VISION_API_KEY = process.env.CURSOR_VISION_API_KEY || '';
const VISION_API_MODEL = process.env.CURSOR_VISION_API_MODEL || 'gpt-4o-mini';

const SVG_PLACEHOLDER = '[SVG vector image was attached but cannot be processed by OCR/Vision. It likely contains a logo, icon, badge, or diagram.]';

/**
 * Preprocess messages: convert image parts to text descriptions.
 * Only processes the last user message's images (historical images
 * were already converted in prior turns).
 *
 * @param {Array<object>} messages - OpenAI-format message array
 * @returns {Promise<Array<object>>} - messages with images replaced by text
 */
export async function preprocessImages(messages) {
    if (!VISION_ENABLED || !messages?.length) return messages;

    // Find last user message with image content
    let lastIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && Array.isArray(messages[i].content)) {
            const hasImage = messages[i].content.some(
                (p) => p.type === 'image_url' || p.type === 'image'
            );
            if (hasImage) { lastIdx = i; break; }
        }
    }
    if (lastIdx === -1) return messages;

    const msg = messages[lastIdx];
    const textParts = [];
    const imageParts = [];
    let svgReplaced = false;

    for (const part of msg.content) {
        if (part.type === 'image_url' || part.type === 'image') {
            const url = part.type === 'image_url'
                ? part.image_url?.url
                : (typeof part.image === 'string' ? part.image : part.image?.url);

            if (isSvg(url)) {
                textParts.push({ type: 'text', text: SVG_PLACEHOLDER });
                svgReplaced = true;
                continue;
            }
            if (url) imageParts.push(url);
        } else {
            textParts.push(part);
        }
    }

    if (imageParts.length === 0 && !svgReplaced) return messages;

    if (imageParts.length > 0) {
        try {
            let description;
            if (VISION_MODE === 'api') {
                description = await callVisionAPI(imageParts);
            } else {
                description = await processWithLocalOCR(imageParts);
            }

            textParts.push({
                type: 'text',
                text: `\n\n[System: The user attached ${imageParts.length} image(s). Visual analysis/OCR extracted the following context:\n${description}]\n\n`,
            });
        } catch (err) {
            logger.error(`[CursorVision] Failed to process images: ${err.message}`);
            textParts.push({
                type: 'text',
                text: `\n\n[System: The user attached image(s), but the Vision interceptor failed to process them. Error: ${err.message}]\n\n`,
            });
        }
    }

    // Shallow-copy messages, replace only the target message's content
    const result = [...messages];
    result[lastIdx] = { ...msg, content: textParts };
    return result;
}

/**
 * Check if a data URL or mime type indicates SVG.
 */
function isSvg(url) {
    if (!url) return false;
    return url.startsWith('data:image/svg') || url.endsWith('.svg');
}

/**
 * Local OCR via tesseract.js (dynamically imported).
 * @param {string[]} imageUrls - data: URLs or remote URLs
 * @returns {Promise<string>}
 */
async function processWithLocalOCR(imageUrls) {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng+chi_sim');
    let combined = '';

    for (let i = 0; i < imageUrls.length; i++) {
        try {
            const { data: { text } } = await worker.recognize(imageUrls[i]);
            combined += `--- Image ${i + 1} OCR Text ---\n${text.trim() || '(No text detected in this image)'}\n\n`;
        } catch (err) {
            logger.error(`[CursorVision] OCR failed for image ${i + 1}: ${err.message}`);
            combined += `--- Image ${i + 1} ---\n(Failed to parse image with local OCR)\n\n`;
        }
    }

    await worker.terminate();
    return combined;
}

/**
 * External Vision API call (OpenAI-compatible).
 * @param {string[]} imageUrls - data: URLs or remote URLs
 * @returns {Promise<string>}
 */
async function callVisionAPI(imageUrls) {
    const parts = [
        { type: 'text', text: 'Please describe the attached images in detail. If they contain code, UI elements, or error messages, explicitly write them out.' },
    ];

    for (const url of imageUrls) {
        parts.push({ type: 'image_url', image_url: { url } });
    }

    const res = await fetch(VISION_API_BASE, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${VISION_API_KEY}`,
        },
        body: JSON.stringify({
            model: VISION_API_MODEL,
            messages: [{ role: 'user', content: parts }],
            max_tokens: 1500,
        }),
    });

    if (!res.ok) {
        throw new Error(`Vision API returned status ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || 'No description returned.';
}
