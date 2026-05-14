import fs from 'fs';
import path from 'path';

import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../../domain/ports/repositories.js';
import { isSkillMaterializableLocally } from '../../../domain/skills/skills.js';

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

export const RUNTIME_MYCLAW_BROWSER_SKILL_ID = 'myclaw-browser';
export const RUNTIME_MYCLAW_BROWSER_SKILL_VERSION = 'myclaw-runtime-v1';

const RUNTIME_MYCLAW_BROWSER_SKILL = `---
name: myclaw-browser
description: Use the MyClaw-managed persistent browser profile for web tasks that require navigation, login state, cookies, or browser actions.
---

# MyClaw Browser

Use this skill when a task needs a real browser session.

MyClaw owns the persistent browser lifecycle and gives each agent conversation its own default profile:

- Use the compact Browser gateway: \`browser_status\`, \`browser_open\`, \`browser_inspect\`, \`browser_act\`, and \`browser_close\`.
- Search first when the destination is unknown. Use \`browser_open\` directly only when the user provided a URL or you have selected a search result.
- Inspect before acting. Use \`browser_inspect\` to understand the current page before each \`browser_act\` interaction.
- Use basic inspection by default. Request full inspection only with a concise reason when basic output is insufficient.
- Close the browser with \`browser_close\` after scheduled jobs or other unattended browser work completes.
- The Browser capability exposes only the MyClaw gateway. Do not request private browser backends or alternate automation tools.
- MyClaw launches the backing browser lazily when an action needs it; \`browser_status\` is read-only and does not launch Chrome.
- Do not install browser skills or edit user \`.claude/skills\` paths.

If a site requires login, launch the headed browser and ask the user to complete authentication in that persistent profile. Do not scrape credentials or bypass normal site authentication.
`;

export class RuntimeInstalledMyClawBrowserSkillSource implements SkillSource {
  async listSkills(input?: {
    enabledSkillIds?: string[];
  }): Promise<ClaudeSkillSourceItem[]> {
    const enabled = input?.enabledSkillIds
      ? input.enabledSkillIds.includes(RUNTIME_MYCLAW_BROWSER_SKILL_ID)
      : true;
    return [
      {
        id: RUNTIME_MYCLAW_BROWSER_SKILL_ID,
        name: RUNTIME_MYCLAW_BROWSER_SKILL_ID,
        sourceType: 'runtime',
        enabled,
        assets: [
          {
            path: 'SKILL.md',
            content: Buffer.from(RUNTIME_MYCLAW_BROWSER_SKILL, 'utf-8'),
          },
          {
            path: 'VERSION',
            content: Buffer.from(
              `${RUNTIME_MYCLAW_BROWSER_SKILL_VERSION}\n`,
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
    const paths = assets.map((asset) => normalizeAssetPath(asset.path));
    return paths.includes('SKILL.md');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Invalid skill asset path:')
    ) {
      return false;
    }
    throw error;
  }
}

function sanitizeSkillName(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
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
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes('\0') ||
    parts.some(
      (part) =>
        part === '..' || part === '.' || part === '' || part.startsWith('.'),
    )
  ) {
    throw new Error(`Invalid skill asset path: ${value}`);
  }
  return parts.join('/');
}
