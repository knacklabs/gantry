import { createHash } from 'node:crypto';

import { parseSkillFrontmatter } from '../shared/skill-artifact-helpers.js';

import { toTrimmedString } from './ipc-shared.js';

export type ParsedSkillPackageAssets =
  | {
      ok: true;
      assets: Array<{
        path: string;
        contentType?: string;
        content: Uint8Array;
      }>;
      fileSummaries: Array<{
        path: string;
        sizeBytes: number;
        fingerprint: string;
      }>;
      skillMarkdownPreview: {
        path: string;
        content: string;
        truncated: boolean;
      };
      metadata: {
        name?: string;
        description?: string;
        requiredEnvVars: string[];
      };
      totalSizeBytes: number;
    }
  | { ok: false; error: string };

const SKILL_MARKDOWN_APPROVAL_MAX_CHARS = 4_000;
const SKILL_MARKDOWN_REVIEW_MAX_CHARS = 90_000;

export function parseSkillPackageAssets(
  files: unknown,
): ParsedSkillPackageAssets {
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

  const assets: Array<{
    path: string;
    contentType?: string;
    content: Uint8Array;
  }> = [];
  const fileSummaries: Array<{
    path: string;
    sizeBytes: number;
    fingerprint: string;
  }> = [];
  let skillMarkdown:
    | {
        path: string;
        content: string;
      }
    | undefined;
  let totalSizeBytes = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object') {
      return { ok: false, error: 'Skill package files must be objects.' };
    }
    const record = file as Record<string, unknown>;
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
      error:
        'Skill package SKILL.md is too large for same-channel review. Keep SKILL.md under 90,000 characters and move long references into bundled resource files.',
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

function fingerprintContent(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function previewSkillMarkdown(input: { path: string; content: string }): {
  path: string;
  content: string;
  truncated: boolean;
} {
  const truncated = input.content.length > SKILL_MARKDOWN_APPROVAL_MAX_CHARS;
  return {
    path: input.path,
    content: truncated
      ? input.content.slice(0, SKILL_MARKDOWN_APPROVAL_MAX_CHARS)
      : input.content,
    truncated,
  };
}

function parseSkillMarkdownMetadata(content: string): {
  name?: string;
  description?: string;
  requiredEnvVars: string[];
} {
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
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(/[,\s]+/))
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  };
}

function cleanMetadataText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
