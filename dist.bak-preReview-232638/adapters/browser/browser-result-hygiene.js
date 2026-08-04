import fs from 'node:fs';
import path from 'node:path';
import { ensureBrowserArtifactRoot, writeBrowserArtifactFileSync, } from './browser-artifact-policy.js';
import { projectBrowserTabsResult } from './browser-tabs.js';
import { sanitizeJsonSafeValue } from '../../shared/json-safe-text.js';
import { nowMs } from '../../shared/time/datetime.js';
const INLINE_SNAPSHOT_COMPACTION_BYTES = 32 * 1024;
const SNAPSHOT_PREVIEW_BYTES = 4 * 1024;
const BROWSER_FILE_OUTPUT_TOOLS = new Set([
    'snapshot',
    'console_messages',
    'network_requests',
    'evaluate',
]);
export function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
export function browserFileReferenceResult(filename, stat, mimeType) {
    return {
        content: [
            {
                type: 'text',
                text: `Saved to ${filename}`,
            },
        ],
        file: {
            path: filename,
            ...(mimeType ? { mimeType } : {}),
            ...(stat?.isFile() ? { sizeBytes: stat.size } : {}),
        },
    };
}
export function writeOptionalTextOutput(text, args) {
    const filename = stringValue(args.filename);
    if (!filename)
        return textResult(text);
    writeBrowserArtifactFileSync(filename, text, 'utf8');
    return browserFileReferenceResult(filename, fs.statSync(filename), 'text/plain');
}
export function normalizeBrowserToolResult(toolName, args, result, options = {}) {
    const sanitized = sanitizeJsonSafeValue(projectBrowserTabsResult(sanitizeInternalChromeTargets(result), options.tabSessionKey, toolName, args));
    const filename = stringValue(args.filename);
    if (!filename || !BROWSER_FILE_OUTPUT_TOOLS.has(toolName)) {
        if (toolName === 'snapshot' && options.artifactRoot) {
            return compactLargeBrowserSnapshot(sanitized, options.artifactRoot);
        }
        return sanitized;
    }
    const stat = browserOutputFileStat(filename);
    if (!stat)
        return sanitized;
    return browserFileReferenceResult(filename, stat, 'text/plain');
}
export function sanitizeBrowserTabsResult(result) {
    return projectBrowserTabsResult(sanitizeInternalChromeTargets(result), undefined, 'tabs', { action: 'list' });
}
export function isInternalChromeTarget(url, title = '') {
    return isInternalChromeTargetText(url) || isInternalChromeTargetText(title);
}
function sanitizeInternalChromeTargets(value) {
    if (Array.isArray(value)) {
        return value
            .filter((item) => !isInternalChromeTargetRecord(item))
            .map(sanitizeInternalChromeTargets);
    }
    if (!value || typeof value !== 'object')
        return value;
    const record = value;
    if (isInternalChromeTargetRecord(record))
        return undefined;
    const next = {};
    for (const [key, item] of Object.entries(record)) {
        if (key === 'content' && Array.isArray(item)) {
            next[key] = sanitizeBrowserContentBlocks(item);
            continue;
        }
        const sanitized = sanitizeInternalChromeTargets(item);
        if (sanitized !== undefined)
            next[key] = sanitized;
    }
    return next;
}
function sanitizeBrowserContentBlocks(blocks) {
    return blocks
        .map((block) => {
        if (!block || typeof block !== 'object')
            return block;
        const row = block;
        if (row.type !== 'text' || typeof row.text !== 'string')
            return block;
        return {
            ...row,
            text: row.text
                .split('\n')
                .filter((line) => !isInternalChromeTargetText(line))
                .join('\n'),
        };
    })
        .filter((block) => {
        if (!block || typeof block !== 'object')
            return true;
        const row = block;
        return row.type !== 'text' || row.text !== '';
    });
}
function compactLargeBrowserSnapshot(result, artifactRoot) {
    const text = browserResultText(result);
    if (Buffer.byteLength(text, 'utf8') <= INLINE_SNAPSHOT_COMPACTION_BYTES) {
        return result;
    }
    const root = ensureBrowserArtifactRoot(artifactRoot);
    const filename = path.join(root, `snapshot-${nowMs()}.txt`);
    writeBrowserArtifactFileSync(filename, text, 'utf8');
    const stat = fs.statSync(filename);
    const preview = truncateUtf8(text, SNAPSHOT_PREVIEW_BYTES);
    return {
        content: [
            {
                type: 'text',
                text: `Saved snapshot to ${filename}\n\nPreview:\n${preview}`,
            },
        ],
        file: {
            path: filename,
            mimeType: 'text/plain',
            sizeBytes: stat.size,
        },
        preview,
    };
}
function browserOutputFileStat(filename) {
    if (!fs.existsSync(filename))
        return undefined;
    const stat = fs.statSync(filename);
    return stat.isFile() ? stat : undefined;
}
function browserResultText(result) {
    if (!result || typeof result !== 'object')
        return String(result ?? '');
    const content = result.content;
    if (!Array.isArray(content))
        return JSON.stringify(result);
    return content
        .map((item) => {
        if (!item || typeof item !== 'object')
            return '';
        const row = item;
        return row.type === 'text' && typeof row.text === 'string'
            ? row.text
            : '';
    })
        .filter(Boolean)
        .join('\n');
}
function isInternalChromeTargetRecord(value) {
    if (!value || typeof value !== 'object')
        return false;
    const row = value;
    return [row.url, row.title].some((item) => typeof item === 'string' && isInternalChromeTargetText(item));
}
function isInternalChromeTargetText(value) {
    const normalized = value.trim().toLowerCase();
    return (normalized.includes('chrome://new-tab-page') ||
        normalized.includes('chrome://omnibox-popup') ||
        normalized === 'omnibox popup' ||
        normalized.includes('omnibox popup') ||
        normalized.startsWith('devtools://'));
}
function truncateUtf8(value, maxBytes) {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes)
        return value;
    let output = '';
    for (const char of value) {
        const next = output + char;
        if (Buffer.byteLength(next, 'utf8') > maxBytes)
            break;
        output = next;
    }
    return output;
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
