import { createHash } from 'node:crypto';

import { toTrimmedString } from './ipc-shared.js';

export type ParsedSkillDraftAssets =
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
        contentHash: string;
      }>;
      skillMarkdownPreview: {
        path: string;
        content: string;
        truncated: boolean;
        contentHash: string;
      };
      totalSizeBytes: number;
    }
  | { ok: false; error: string };

const SKILL_MARKDOWN_APPROVAL_MAX_CHARS = 4_000;

export function parseSkillDraftAssets(files: unknown): ParsedSkillDraftAssets {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'Skill draft must include at least one file.' };
  }
  if (files.length > 50) {
    return {
      ok: false,
      error: 'Skill draft cannot include more than 50 files.',
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
    contentHash: string;
  }> = [];
  let skillMarkdown:
    | {
        path: string;
        content: string;
        contentHash: string;
      }
    | undefined;
  let totalSizeBytes = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object') {
      return { ok: false, error: 'Skill draft files must be objects.' };
    }
    const record = file as Record<string, unknown>;
    const filePath = toTrimmedString(record.path, { maxLen: 256 });
    const content = typeof record.content === 'string' ? record.content : '';
    const contentType = toTrimmedString(record.contentType, { maxLen: 128 });
    if (!filePath) {
      return { ok: false, error: 'Skill draft file path is required.' };
    }
    if (typeof record.content !== 'string') {
      return {
        ok: false,
        error: `Skill draft file ${filePath} must include string content.`,
      };
    }
    const bytes = Buffer.from(content, 'utf-8');
    totalSizeBytes += bytes.byteLength;
    if (totalSizeBytes > 1024 * 1024) {
      return {
        ok: false,
        error: 'Skill draft files cannot exceed 1 MiB total.',
      };
    }
    assets.push({
      path: filePath,
      ...(contentType ? { contentType } : {}),
      content: bytes,
    });
    const contentHash = sha256(bytes);
    fileSummaries.push({
      path: filePath,
      sizeBytes: bytes.byteLength,
      contentHash,
    });
    if (filePath === 'SKILL.md') {
      skillMarkdown = { path: filePath, content, contentHash };
    }
  }
  if (!skillMarkdown) {
    return { ok: false, error: 'Skill draft must include SKILL.md.' };
  }
  if (skillMarkdown.content.length > SKILL_MARKDOWN_APPROVAL_MAX_CHARS) {
    return {
      ok: false,
      error:
        'Agent-created skill SKILL.md is too large for same-channel approval. Use a smaller SKILL.md or upload it through an admin review flow.',
    };
  }
  return {
    ok: true,
    assets,
    fileSummaries,
    skillMarkdownPreview: previewSkillMarkdown(skillMarkdown),
    totalSizeBytes,
  };
}

function sha256(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function previewSkillMarkdown(input: {
  path: string;
  content: string;
  contentHash: string;
}): {
  path: string;
  content: string;
  truncated: boolean;
  contentHash: string;
} {
  const truncated = input.content.length > SKILL_MARKDOWN_APPROVAL_MAX_CHARS;
  return {
    path: input.path,
    content: truncated
      ? input.content.slice(0, SKILL_MARKDOWN_APPROVAL_MAX_CHARS)
      : input.content,
    truncated,
    contentHash: input.contentHash,
  };
}
