import { createHash } from 'node:crypto';
import { toTrimmedString } from './ipc-shared.js';
const SKILL_MARKDOWN_APPROVAL_MAX_CHARS = 4_000;
const SKILL_MARKDOWN_REVIEW_MAX_CHARS = 90_000;
export function parseSkillPackageAssets(files) {
    if (!Array.isArray(files) || files.length === 0) {
        return {
            ok: false,
            error: 'Skill package must include at least one file.',
        };
    }
    if (files.length > 50) {
        return {
            ok: false,
            error: 'Skill package cannot include more than 50 files.',
        };
    }
    const assets = [];
    const fileSummaries = [];
    let skillMarkdown;
    let totalSizeBytes = 0;
    for (const file of files) {
        if (!file || typeof file !== 'object') {
            return { ok: false, error: 'Skill package files must be objects.' };
        }
        const record = file;
        const filePath = toTrimmedString(record.path, { maxLen: 256 });
        const content = typeof record.content === 'string' ? record.content : '';
        const contentType = toTrimmedString(record.contentType, { maxLen: 128 });
        if (!filePath) {
            return { ok: false, error: 'Skill package file path is required.' };
        }
        if (typeof record.content !== 'string') {
            return {
                ok: false,
                error: `Skill package file ${filePath} must include string content.`,
            };
        }
        const bytes = Buffer.from(content, 'utf-8');
        totalSizeBytes += bytes.byteLength;
        if (totalSizeBytes > 1024 * 1024) {
            return {
                ok: false,
                error: 'Skill package files cannot exceed 1 MiB total.',
            };
        }
        assets.push({
            path: filePath,
            ...(contentType ? { contentType } : {}),
            content: bytes,
        });
        const fingerprint = fingerprintContent(bytes);
        fileSummaries.push({
            path: filePath,
            sizeBytes: bytes.byteLength,
            fingerprint,
        });
        if (filePath === 'SKILL.md') {
            skillMarkdown = { path: filePath, content };
        }
    }
    if (!skillMarkdown) {
        return { ok: false, error: 'Skill package must include SKILL.md.' };
    }
    if (skillMarkdown.content.length > SKILL_MARKDOWN_REVIEW_MAX_CHARS) {
        return {
            ok: false,
            error: 'Skill package SKILL.md is too large for same-channel review. Keep SKILL.md under 90,000 characters and move long references into bundled resource files.',
        };
    }
    return {
        ok: true,
        assets,
        fileSummaries,
        skillMarkdownPreview: previewSkillMarkdown(skillMarkdown),
        metadata: parseSkillMarkdownMetadata(skillMarkdown.content),
        totalSizeBytes,
    };
}
function fingerprintContent(content) {
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
function previewSkillMarkdown(input) {
    const truncated = input.content.length > SKILL_MARKDOWN_APPROVAL_MAX_CHARS;
    return {
        path: input.path,
        content: truncated
            ? input.content.slice(0, SKILL_MARKDOWN_APPROVAL_MAX_CHARS)
            : input.content,
        truncated,
    };
}
function parseSkillMarkdownMetadata(content) {
    const frontmatter = parseSkillFrontmatter(content);
    return {
        name: cleanMetadataText(frontmatter.name),
        description: cleanMetadataText(frontmatter.description),
        requiredEnvVars: [
            frontmatter.required_env,
            frontmatter.required_env_vars,
            frontmatter.env,
            frontmatter.env_vars,
        ]
            .filter((value) => Boolean(value))
            .flatMap((value) => value.split(/[,\s]+/))
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
    };
}
function parseSkillFrontmatter(content) {
    if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
        return {};
    }
    const normalized = content.replace(/\r\n/g, '\n');
    const end = normalized.indexOf('\n---', 4);
    if (end < 0)
        return {};
    const lines = normalized.slice(4, end).split('\n');
    const metadata = {};
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
        if (!match)
            continue;
        const key = match[1];
        const rawValue = match[2];
        if (rawValue === '|') {
            const block = [];
            while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
                i += 1;
                block.push(lines[i].replace(/^\s{2}/, ''));
            }
            metadata[key] = block.join('\n').trim();
            continue;
        }
        metadata[key] = rawValue.replace(/^['"]|['"]$/g, '').trim();
    }
    return metadata;
}
function cleanMetadataText(value) {
    const trimmed = value?.trim();
    return trimmed || undefined;
}
