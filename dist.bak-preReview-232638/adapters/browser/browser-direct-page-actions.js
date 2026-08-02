import fs from 'node:fs';
import path from 'node:path';
import { ensureBrowserArtifactRoot, writeBrowserArtifactFileSync, } from './browser-artifact-policy.js';
import { browserFileReferenceResult } from './browser-result-hygiene.js';
import { nowMs } from '../../shared/time/datetime.js';
const DEFAULT_SCREENSHOT_MAX_SIDE = 2_000;
const DEFAULT_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export async function snapshotPage(page, args) {
    const target = stringValue(args.target);
    if (target) {
        const locator = await resolveTargetLocator(page, target);
        const text = await locator.innerText({ timeout: 30_000 }).catch(() => '');
        return text || `Snapshot target ${target} has no visible text.`;
    }
    const data = await page.evaluate(() => {
        const doc = globalThis.document;
        const loc = globalThis.location;
        for (const element of Array.from(doc.querySelectorAll('[data-gantry-ref]'))) {
            element.removeAttribute('data-gantry-ref');
        }
        const candidates = Array.from(doc.querySelectorAll('a,button,input,textarea,select,[role],[tabindex],[onclick]')).filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
        const elements = candidates
            .slice(0, 200)
            .map((element, index) => {
            const ref = `e${index + 1}`;
            element.setAttribute('data-gantry-ref', ref);
            const label = element.getAttribute('aria-label') ||
                element.innerText ||
                element.value ||
                element.getAttribute('title') ||
                element.getAttribute('href') ||
                element.tagName.toLowerCase();
            return {
                ref,
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute('role') || undefined,
                label: String(label).replace(/\s+/g, ' ').trim().slice(0, 200),
            };
        });
        const bodyText = (doc.body?.innerText || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 4000);
        return {
            title: doc.title,
            url: loc.href,
            bodyText,
            elements,
        };
    });
    const lines = [
        `Title: ${data.title || '(untitled)'}`,
        `URL: ${data.url}`,
        '',
        'Interactive elements:',
        ...data.elements.map((item) => `- ${item.ref}: ${item.role || item.tag} "${item.label || '(unlabeled)'}"`),
        '',
        'Text:',
        data.bodyText,
    ];
    return lines.join('\n').trim();
}
export async function takeScreenshot(page, args, outputDir) {
    const requested = stringValue(args.filename);
    const filename = requested ||
        path.join(ensureBrowserArtifactRoot(outputDir), 'screenshots', `screenshot-${nowMs()}.${args.type === 'jpeg' ? 'jpg' : 'png'}`);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const target = stringValue(args.target);
    const normalized = target
        ? await normalizedScreenshot(await resolveTargetLocator(page, target), args)
        : await normalizedScreenshot(page, args);
    writeBrowserArtifactFileSync(filename, normalized.buffer);
    const stat = fs.statSync(filename);
    return browserFileReferenceResult(filename, stat, normalized.mimeType);
}
export async function resolveTargetLocator(page, target) {
    if (/^e\d+$/.test(target)) {
        return page.locator(`[data-gantry-ref="${target}"]`).first();
    }
    const locator = page.locator(target).first();
    const count = await locator.count().catch(() => 0);
    if (count > 0)
        return locator;
    return page.getByText(target).first();
}
async function normalizedScreenshot(target, args) {
    const page = isPage(target) ? target : undefined;
    const fullPage = args.fullPage === true && page !== undefined;
    const requestedJpeg = args.type === 'jpeg';
    const capture = async (opts) => (await target.screenshot({
        type: opts.type,
        ...(page ? { fullPage: opts.fullPage } : {}),
        ...(opts.quality ? { quality: opts.quality } : {}),
    }));
    let buffer = await capture({
        type: requestedJpeg ? 'jpeg' : 'png',
        fullPage,
    });
    let mimeType = requestedJpeg ? 'image/jpeg' : 'image/png';
    const dimensions = imageDimensions(buffer);
    const maxSide = Math.max(1, DEFAULT_SCREENSHOT_MAX_SIDE);
    if (!fullPage &&
        dimensions &&
        Math.max(dimensions.width, dimensions.height) > maxSide) {
        if (!page) {
            throw new Error(`Browser screenshot exceeds max side ${DEFAULT_SCREENSHOT_MAX_SIDE}px.`);
        }
        const scale = maxSide / Math.max(dimensions.width, dimensions.height);
        const viewport = page.viewportSize();
        if (viewport) {
            try {
                await page.setViewportSize({
                    width: Math.max(1, Math.round(viewport.width * scale)),
                    height: Math.max(1, Math.round(viewport.height * scale)),
                });
                buffer = await capture({
                    type: requestedJpeg ? 'jpeg' : 'png',
                    fullPage,
                });
                mimeType = requestedJpeg ? 'image/jpeg' : 'image/png';
                if (buffer.byteLength > DEFAULT_SCREENSHOT_MAX_BYTES) {
                    const compressed = await compressScreenshot({
                        capture,
                        fullPage,
                    });
                    buffer = compressed.buffer;
                    mimeType = compressed.mimeType;
                }
            }
            finally {
                await page.setViewportSize(viewport).catch(() => undefined);
            }
            return ensureScreenshotWithinByteLimit(buffer, mimeType);
        }
    }
    if (buffer.byteLength <= DEFAULT_SCREENSHOT_MAX_BYTES) {
        return { buffer, mimeType };
    }
    return await compressScreenshot({ capture, fullPage });
}
async function compressScreenshot(input) {
    let buffer;
    for (const quality of [85, 75, 65, 55, 45, 35]) {
        buffer = await input.capture({
            type: 'jpeg',
            quality,
            fullPage: input.fullPage,
        });
        if (buffer.byteLength <= DEFAULT_SCREENSHOT_MAX_BYTES)
            break;
    }
    if (!buffer)
        throw new Error('Browser screenshot compression failed.');
    return ensureScreenshotWithinByteLimit(buffer, 'image/jpeg');
}
function ensureScreenshotWithinByteLimit(buffer, mimeType) {
    if (buffer.byteLength > DEFAULT_SCREENSHOT_MAX_BYTES) {
        throw new Error(`Browser screenshot could not be reduced below ${DEFAULT_SCREENSHOT_MAX_BYTES} bytes.`);
    }
    return { buffer, mimeType };
}
function isPage(value) {
    return typeof value.viewportSize === 'function';
}
function imageDimensions(buffer) {
    if (buffer.length >= 24 &&
        buffer[0] === 0x89 &&
        buffer.toString('ascii', 1, 4) === 'PNG') {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff)
                return undefined;
            const marker = buffer[offset + 1];
            const length = buffer.readUInt16BE(offset + 2);
            if (marker && marker >= 0xc0 && marker <= 0xc3) {
                return {
                    height: buffer.readUInt16BE(offset + 5),
                    width: buffer.readUInt16BE(offset + 7),
                };
            }
            offset += 2 + length;
        }
    }
    return undefined;
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
