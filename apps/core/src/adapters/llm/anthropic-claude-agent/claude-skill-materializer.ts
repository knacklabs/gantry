import fs from 'fs';
import path from 'path';

import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../../domain/ports/repositories.js';
import { isSkillMaterializableLocally } from '../../../domain/skills/skills.js';

export {
  BROWSER_ACTION_MCP_SERVER_NAME,
  createBrowserActionMcpServerConfig,
} from '../../browser/action-mcp.js';

export interface ClaudeSkillSourceItem {
  id: string;
  name: string;
  sourceType?: 'bundled' | 'artifact' | 'runtime';
  sourceDir?: string;
  assets?: Array<{ path: string; content: Uint8Array }>;
  enabled: boolean;
}

export interface SkillSource {
  listSkills(input?: {
    enabledSkillIds?: string[];
  }): Promise<ClaudeSkillSourceItem[]>;
}

export class BundledClaudeSkillSource implements SkillSource {
  constructor(private readonly packageRoot: string) {}

  async listSkills(input?: {
    enabledSkillIds?: string[];
  }): Promise<ClaudeSkillSourceItem[]> {
    const skillsRoot = path.join(this.packageRoot, '.claude', 'skills');
    if (!fs.existsSync(skillsRoot)) return [];
    const enabled = input?.enabledSkillIds
      ? new Set(input.enabledSkillIds)
      : undefined;

    return fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const sourceDir = path.join(skillsRoot, entry.name);
        return {
          id: entry.name,
          name: entry.name,
          sourceType: 'bundled',
          sourceDir,
          enabled: !enabled || enabled.has(entry.name),
        };
      });
  }
}

export class ArtifactClaudeSkillSource implements SkillSource {
  constructor(
    private readonly skills: SkillCatalogRepository,
    private readonly artifacts: SkillArtifactStore,
    private readonly context: { appId: AppId; agentId: AgentId },
  ) {}

  async listSkills(input?: {
    enabledSkillIds?: string[];
  }): Promise<ClaudeSkillSourceItem[]> {
    const allowed = input?.enabledSkillIds
      ? new Set(input.enabledSkillIds)
      : undefined;
    const enabled = await this.skills.listEnabledSkillsForAgent(this.context);
    const items: ClaudeSkillSourceItem[] = [];
    for (const skill of enabled.filter(isSkillMaterializableLocally)) {
      if (allowed && !allowed.has(skill.id) && !allowed.has(skill.name)) {
        continue;
      }
      if (!skill.storage) continue;
      const bundle = await this.artifacts.getSkillArtifact(
        skill.storage.storageRef,
      );
      items.push({
        id: skill.id,
        name: skill.name,
        sourceType: 'artifact',
        assets: bundle.assets,
        enabled: true,
      });
    }
    return items;
  }
}

export const RUNTIME_AGENT_BROWSER_SKILL_ID = 'agent-browser';
export const RUNTIME_AGENT_BROWSER_SKILL_VERSION = 'myclaw-runtime-v1';

const RUNTIME_AGENT_BROWSER_SKILL = `---
name: agent-browser
description: Use the MyClaw-managed persistent browser profile for web tasks that require navigation, login state, cookies, or browser actions.
---

# Agent Browser

Use this skill when a task needs a real browser session.

MyClaw owns the persistent browser lifecycle and profile:

- Use \`mcp__myclaw__browser_status\` to inspect the shared \`myclaw\` profile.
- Use \`mcp__myclaw__browser_launch\` to launch or reuse it. The default launch is headed and cookie-preserving.
- Use the runtime \`mcp__agent_browser__*\` browser action tools to navigate, click, type, wait, snapshot, or screenshot. MyClaw attaches them to \`PLAYWRIGHT_MCP_CDP_ENDPOINT\`.
- Do not install browser skills or edit user \`.claude/skills\` paths.

If a site requires login, launch the headed browser and ask the user to complete authentication in that persistent profile. Do not scrape credentials or bypass normal site authentication.
`;

export class RuntimeInstalledAgentBrowserSkillSource implements SkillSource {
  async listSkills(input?: {
    enabledSkillIds?: string[];
  }): Promise<ClaudeSkillSourceItem[]> {
    const enabled = input?.enabledSkillIds
      ? input.enabledSkillIds.includes(RUNTIME_AGENT_BROWSER_SKILL_ID)
      : true;
    return [
      {
        id: RUNTIME_AGENT_BROWSER_SKILL_ID,
        name: RUNTIME_AGENT_BROWSER_SKILL_ID,
        sourceType: 'runtime',
        enabled,
        assets: [
          {
            path: 'SKILL.md',
            content: Buffer.from(RUNTIME_AGENT_BROWSER_SKILL, 'utf-8'),
          },
          {
            path: 'VERSION',
            content: Buffer.from(
              `${RUNTIME_AGENT_BROWSER_SKILL_VERSION}\n`,
              'utf-8',
            ),
          },
        ],
      },
    ];
  }
}

export class CompositeSkillSource implements SkillSource {
  constructor(private readonly sources: SkillSource[]) {}

  async listSkills(input?: {
    enabledSkillIds?: string[];
  }): Promise<ClaudeSkillSourceItem[]> {
    const skills: ClaudeSkillSourceItem[] = [];
    for (const source of this.sources) {
      skills.push(...(await source.listSkills(input)));
    }
    return skills;
  }
}

export async function materializeClaudeSkills(input: {
  skillSource: SkillSource;
  skillsDir: string;
  enabledSkillIds?: string[];
}): Promise<ClaudeSkillSourceItem[]> {
  const skills = await input.skillSource.listSkills({
    enabledSkillIds: input.enabledSkillIds,
  });
  fs.mkdirSync(input.skillsDir, { recursive: true, mode: 0o700 });

  const materialized: ClaudeSkillSourceItem[] = [];
  const targetDirs = new Set<string>();
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const targetName = skill.assets
      ? sanitizeSkillName(skill.id)
      : sanitizeSkillName(skill.name);
    if (targetDirs.has(targetName)) continue;
    targetDirs.add(targetName);
    const targetDir = path.join(input.skillsDir, targetName);
    fs.rmSync(targetDir, { recursive: true, force: true });
    if (skill.assets) {
      if (!isValidAssetSkill(skill.assets)) {
        continue;
      }
      writeAssets(skill.assets, targetDir);
    } else if (skill.sourceDir) {
      const sourceDir = path.resolve(skill.sourceDir);
      const skillFile = path.join(sourceDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      copyDirRecursive(sourceDir, targetDir);
    } else {
      continue;
    }
    materialized.push(skill);
  }
  return materialized;
}

function isValidAssetSkill(
  assets: Array<{ path: string; content: Uint8Array }>,
): boolean {
  try {
    return assets.some(
      (asset) => normalizeAssetPath(asset.path) === 'SKILL.md',
    );
  } catch {
    return false;
  }
}

function sanitizeSkillName(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
  return safe || 'skill';
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function writeAssets(
  assets: Array<{ path: string; content: Uint8Array }>,
  targetDir: string,
): void {
  const root = path.resolve(targetDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const asset of assets) {
    const relative = normalizeAssetPath(asset.path);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(asset.content), { mode: 0o600 });
  }
}

function normalizeAssetPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Invalid skill asset path: ${value}`);
  }
  return normalized;
}
