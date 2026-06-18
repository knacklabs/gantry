import path from 'path';

import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../../domain/ports/repositories.js';
import type { SkillCatalogItem } from '../../../domain/skills/skills.js';
import {
  isSkillMaterializableLocally,
  materializedSkillDirectoryNameFor,
} from '../../../domain/skills/skills.js';
import {
  formatSkillMaterializationCollision,
  skillMaterializationCollisions,
} from '../../../domain/skills/skill-identity.js';
import type { DeepAgentSkillProjection } from '../../../application/agent-execution/agent-execution-adapter.js';
import {
  cleanSkillMetadataText,
  normalizeSkillAssetPath,
  parseSkillFrontmatter,
} from '../skill-artifact-helpers.js';

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
  if (
    !input.skillRepository ||
    !input.skillArtifactStore ||
    !input.skillContext
  ) {
    throw new Error(
      'DeepAgents selected skills require configured Gantry skill storage before runner spawn. Unselect the skill or restart Gantry with skill storage configured.',
    );
  }

  const enabledSkills = await input.skillRepository.listEnabledSkillsForAgent({
    appId: input.skillContext.appId as AppId,
    agentId: input.skillContext.agentId as AgentId,
  });
  const enabledById = new Map(
    enabledSkills.map((skill) => [String(skill.id), skill]),
  );
  const selectedSkills = selectedSkillIds.map((skillId) => {
    const skill = enabledById.get(skillId);
    if (!skill) {
      throw new Error(
        `DeepAgents selected skill "${skillId}" is not enabled for this agent. Unselect it or install and bind the skill before using DeepAgents.`,
      );
    }
    if (!isSkillMaterializableLocally(skill) || !skill.storage) {
      throw new Error(
        `DeepAgents selected skill "${skillId}" is not installed with a materializable artifact. Unselect or reinstall the skill before using DeepAgents.`,
      );
    }
    return skill;
  });
  const collisions = skillMaterializationCollisions(selectedSkills);
  if (collisions.length > 0) {
    throw new Error(
      `DeepAgents selected skills cannot be projected: ${formatSkillMaterializationCollision(collisions[0])}`,
    );
  }

  const now = input.nowIso?.() ?? new Date().toISOString();
  const files: DeepAgentSkillProjection['files'] = {};
  let contentBytes = 0;
  for (const skill of selectedSkills) {
    const skillFiles = await projectSkillFiles({
      skill,
      artifactStore: input.skillArtifactStore,
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
    selectedSkillIds,
    skillCount: selectedSkills.length,
    fileCount: Object.keys(files).length,
    contentBytes,
  };
}

async function projectSkillFiles(input: {
  skill: SkillCatalogItem;
  artifactStore: SkillArtifactStore;
  now: string;
}): Promise<{
  files: DeepAgentSkillProjection['files'];
  contentBytes: number;
}> {
  if (!input.skill.storage) {
    throw new Error(
      `DeepAgents selected skill "${input.skill.id}" is missing artifact storage.`,
    );
  }
  const targetName = materializedSkillDirectoryNameFor(input.skill.name);
  const bundle = await input.artifactStore.getSkillArtifact(
    input.skill.storage.storageRef,
  );
  const assets = bundle.assets
    .map((asset) => ({
      path: normalizeSkillAssetPath(asset.path),
      contentType: asset.contentType,
      content: asset.content,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  for (const asset of assets) {
    if (paths.has(asset.path)) {
      throw new Error(
        `DeepAgents selected skill "${input.skill.id}" has duplicate artifact path "${asset.path}".`,
      );
    }
    paths.add(asset.path);
  }
  const skillMd = assets.find((asset) => asset.path === SKILL_MD);
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
  for (const asset of assets) {
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
  skill: SkillCatalogItem;
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
  } catch {
    throw new Error(
      `DeepAgents selected skill "${input.skillId}" asset "${input.assetPath}" must be UTF-8 text.`,
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
