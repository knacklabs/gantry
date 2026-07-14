import path from 'path';

import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../../domain/ports/repositories.js';
import { materializedSkillDirectoryNameFor } from '../../../domain/skills/skills.js';
import type { DeepAgentSkillProjection } from '../../../application/agent-execution/agent-execution-adapter.js';
import {
  resolveSelectedSkillProjection,
  type SelectedSkillProjectionItem,
} from '../../../application/skills/selected-skill-projection.js';
import {
  cleanSkillMetadataText,
  parseSkillFrontmatter,
} from '../../../shared/skill-artifact-helpers.js';

const DEEPAGENTS_SKILLS_SOURCE = '/skills/';
const SKILL_MD = 'SKILL.md';
const MAX_SKILL_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export async function resolveDeepAgentSkillProjection(input: {
  selectedSkillIds?: readonly string[];
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  skillContext?: { appId: string; agentId: string };
  nowIso?: () => string;
}): Promise<DeepAgentSkillProjection | undefined> {
  const selectedSkillIds = uniqueStrings(input.selectedSkillIds ?? []);
  if (selectedSkillIds.length === 0) return undefined;
  const projection = await resolveSelectedSkillProjection({
    selectedSkillIds,
    skillRepository: input.skillRepository,
    skillArtifactStore: input.skillArtifactStore,
    skillContext: input.skillContext,
  });
  if (!projection) return undefined;

  const now = input.nowIso?.() ?? new Date().toISOString();
  const files: DeepAgentSkillProjection['files'] = {};
  let contentBytes = 0;
  for (const skill of projection.skills) {
    const skillFiles = await projectSkillFiles({
      skill,
      now,
    });
    for (const [filePath, fileData] of Object.entries(skillFiles.files)) {
      files[filePath] = fileData;
    }
    contentBytes += skillFiles.contentBytes;
  }

  return {
    sources: [DEEPAGENTS_SKILLS_SOURCE],
    files,
    selectedSkillIds: projection.selectedSkillIds,
    skillCount: projection.skillCount,
    fileCount: Object.keys(files).length,
    contentBytes,
  };
}

export function reconcileDeepAgentSkillFiles(input: {
  currentFiles?: DeepAgentSkillProjection['files'];
  checkpointTuple?: unknown;
}):
  | Record<string, DeepAgentSkillProjection['files'][string] | null>
  | undefined {
  const update: Record<
    string,
    DeepAgentSkillProjection['files'][string] | null
  > = { ...(input.currentFiles ?? {}) };
  const tuple = objectRecord(input.checkpointTuple);
  const checkpoint = objectRecord(tuple?.checkpoint);
  const channelValues =
    objectRecord(checkpoint?.channel_values) ??
    objectRecord(checkpoint?.channelValues);
  const files = objectRecord(channelValues?.files);
  for (const filePath of Object.keys(files ?? {})) {
    if (
      filePath.startsWith(DEEPAGENTS_SKILLS_SOURCE) &&
      !(filePath in update)
    ) {
      update[filePath] = null;
    }
  }
  return Object.keys(update).length > 0 ? update : undefined;
}

async function projectSkillFiles(input: {
  skill: SelectedSkillProjectionItem;
  now: string;
}): Promise<{
  files: DeepAgentSkillProjection['files'];
  contentBytes: number;
}> {
  const targetName = materializedSkillDirectoryNameFor(input.skill.name);
  const skillMd = input.skill.assets.find((asset) => asset.path === SKILL_MD);
  if (!skillMd) {
    throw new Error(
      `DeepAgents selected skill "${input.skill.id}" artifact must include SKILL.md.`,
    );
  }
  const skillMdText = decodeUtf8Asset({
    skillId: String(input.skill.id),
    assetPath: skillMd.path,
    content: skillMd.content,
  });
  validateDeepAgentSkillMetadata({
    skill: input.skill,
    targetName,
    skillText: skillMdText,
  });

  const files: DeepAgentSkillProjection['files'] = {};
  let contentBytes = 0;
  for (const asset of input.skill.assets) {
    const mimeType = asset.contentType ?? contentTypeForPath(asset.path);
    if (!isTextMimeType(mimeType)) {
      throw new Error(
        `DeepAgents selected skill "${input.skill.id}" asset "${asset.path}" has unsupported binary content type "${mimeType}".`,
      );
    }
    const content = decodeUtf8Asset({
      skillId: String(input.skill.id),
      assetPath: asset.path,
      content: asset.content,
    });
    files[`${DEEPAGENTS_SKILLS_SOURCE}${targetName}/${asset.path}`] = {
      content,
      mimeType,
      created_at: input.now,
      modified_at: input.now,
    };
    contentBytes += asset.content.byteLength;
  }
  return { files, contentBytes };
}

function validateDeepAgentSkillMetadata(input: {
  skill: SelectedSkillProjectionItem;
  targetName: string;
  skillText: string;
}): void {
  if (Buffer.byteLength(input.skillText, 'utf-8') > MAX_SKILL_FILE_SIZE_BYTES) {
    throw new Error(
      `DeepAgents selected skill "${input.skill.id}" SKILL.md exceeds the official 10 MB limit.`,
    );
  }
  const frontmatter = parseSkillFrontmatter(input.skillText);
  const name = cleanSkillMetadataText(frontmatter.name);
  const description = cleanSkillMetadataText(frontmatter.description);
  if (!name || !description) {
    throw new Error(
      `DeepAgents selected skill "${input.skill.id}" SKILL.md must declare frontmatter name and description.`,
    );
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(
      `DeepAgents selected skill "${input.skill.id}" name exceeds the official 64 character limit.`,
    );
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new Error(
      `DeepAgents selected skill "${input.skill.id}" description exceeds the official 1024 character limit.`,
    );
  }
  if (!isDeepAgentSkillName(name) || name !== input.targetName) {
    throw new Error(
      `DeepAgents selected skill "${input.skill.id}" declares SDK skill name "${name}" but materializes as "${input.targetName}". Use a lowercase hyphenated SKILL.md name that matches the Gantry materialized skill directory.`,
    );
  }
}

function isDeepAgentSkillName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SKILL_NAME_LENGTH &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

function decodeUtf8Asset(input: {
  skillId: string;
  assetPath: string;
  content: Uint8Array;
}): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input.content);
  } catch (error) {
    throw new Error(
      `DeepAgents selected skill "${input.skillId}" asset "${input.assetPath}" must be UTF-8 text.`,
      { cause: error },
    );
  }
}

function contentTypeForPath(assetPath: string): string {
  const ext = path.extname(assetPath).toLowerCase();
  if (ext === '.md') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return 'application/javascript';
  }
  if (ext === '.svg') return 'image/svg+xml';
  return 'text/plain';
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'image/svg+xml'
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
