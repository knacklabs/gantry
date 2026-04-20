import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { AGENT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';

const CLAUDE_SESSION_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveRepoRootFromSourceDir(SOURCE_DIR);
const AGENT_RUNNER_HOST_DIR = path.join(REPO_ROOT, 'packages', 'agent-runner');
export const IPC_GROUP_SUBDIRS = [
  'messages',
  'tasks',
  'input',
  'memory-requests',
  'memory-responses',
  'browser-requests',
  'browser-responses',
  'permission-requests',
  'permission-responses',
  'user-questions',
  'user-answers',
  'task-responses',
] as const;
const BUNDLED_SKILL_VERSION_FILENAME = '.version';
const REMOVED_BUNDLED_SKILLS = new Set([['setup', 'mini', 'app'].join('-')]);

function readPackageVersion(root: string): string | null {
  try {
    const pkgPath = path.join(root, 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateSemver = parseSemver(candidate);
  const currentSemver = parseSemver(current);

  if (!candidateSemver || !currentSemver) {
    return candidate !== current;
  }

  for (let i = 0; i < 3; i += 1) {
    if (candidateSemver[i] > currentSemver[i]) return true;
    if (candidateSemver[i] < currentSemver[i]) return false;
  }
  return false;
}

function readInstalledSkillVersion(skillDir: string): string | null {
  const versionPath = path.join(skillDir, BUNDLED_SKILL_VERSION_FILENAME);
  try {
    const raw = fs.readFileSync(versionPath, 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeInstalledSkillVersion(skillDir: string, version: string): void {
  fs.writeFileSync(
    path.join(skillDir, BUNDLED_SKILL_VERSION_FILENAME),
    `${version}\n`,
  );
}

function pruneRemovedBundledSkills(skillsDst: string): void {
  for (const skill of REMOVED_BUNDLED_SKILLS) {
    const dst = path.join(skillsDst, skill);
    if (!fs.existsSync(dst)) continue;

    const stat = fs.lstatSync(dst);
    if (!stat.isDirectory() || !readInstalledSkillVersion(dst)) continue;

    fs.rmSync(dst, { recursive: true, force: true });
    logger.info({ skill }, 'Removed obsolete bundled skill');
  }
}

export function resolveRepoRootFromSourceDir(sourceDir: string): string {
  let currentDir = path.resolve(sourceDir);

  while (true) {
    if (
      fs.existsSync(path.join(currentDir, 'package.json')) &&
      fs.existsSync(path.join(currentDir, 'packages', 'agent-runner'))
    ) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return process.cwd();
}

/**
 * Ensure shared .claude/settings.json under AGENT_ROOT.
 * This is the single HOME for all agent processes.
 */
export function ensureSharedSessionSettings(): void {
  const claudeDir = path.join(AGENT_ROOT, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');

  let existingSettings: unknown = {};
  if (fs.existsSync(settingsFile)) {
    try {
      existingSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    } catch {
      existingSettings = {};
    }
  }

  const current =
    existingSettings && typeof existingSettings === 'object'
      ? (existingSettings as Record<string, unknown>)
      : {};
  const existingEnv =
    current.env && typeof current.env === 'object'
      ? (current.env as Record<string, unknown>)
      : {};
  const merged = {
    ...current,
    env: {
      ...existingEnv,
      ...CLAUDE_SESSION_SETTINGS.env,
    },
  };

  fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + '\n');
}

/**
 * Ensure AGENT_ROOT/.claude/skills/ exists as a real directory.
 * Skills are managed directly under this directory (single source of truth).
 * Existing symlinks are migrated to real directories automatically.
 * Bundled skills from the package are copied if not already present.
 * Existing skills are updated only when their bundled version is older.
 */
export function syncGroupSkills(): void {
  const skillsDst = path.join(AGENT_ROOT, '.claude', 'skills');
  const bundledVersion = readPackageVersion(REPO_ROOT);

  // Migrate symlink to a real directory.
  try {
    const stat = fs.lstatSync(skillsDst);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(skillsDst);
    }
  } catch {
    // doesn't exist yet
  }

  fs.mkdirSync(skillsDst, { recursive: true });
  pruneRemovedBundledSkills(skillsDst);

  // Copy bundled skills from the package into the runtime skills directory.
  // Existing skills are only overwritten when a newer package version exists.
  const bundledSkillsDir = path.join(REPO_ROOT, '.claude', 'skills');
  try {
    if (!fs.existsSync(bundledSkillsDir)) return;
    const entries = fs.readdirSync(bundledSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = path.join(bundledSkillsDir, entry.name);
      const dst = path.join(skillsDst, entry.name);
      if (!fs.existsSync(dst)) {
        copyDirRecursive(src, dst);
        if (bundledVersion) {
          writeInstalledSkillVersion(dst, bundledVersion);
        }
        logger.info({ skill: entry.name }, 'Installed bundled skill');
        continue;
      }

      if (!bundledVersion) continue;

      const installedVersion = readInstalledSkillVersion(dst);
      if (!installedVersion) {
        // Existing install without a managed version marker: preserve current
        // files and stamp the version so future upgrades are trackable.
        writeInstalledSkillVersion(dst, bundledVersion);
        logger.info(
          { skill: entry.name, version: bundledVersion },
          'Stamped bundled skill version for existing install',
        );
        continue;
      }

      if (!isNewerVersion(bundledVersion, installedVersion)) continue;
      fs.rmSync(dst, { recursive: true, force: true });
      copyDirRecursive(src, dst);
      writeInstalledSkillVersion(dst, bundledVersion);
      logger.info(
        { skill: entry.name, from: installedVersion, to: bundledVersion },
        'Updated bundled skill to newer package version',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to sync bundled skills');
  }
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      logger.warn(
        { path: srcPath },
        'Skipping symlink while syncing bundled skills',
      );
      continue;
    }
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

export function getRepoAgentRunnerRoot(): string {
  return AGENT_RUNNER_HOST_DIR;
}

export function getHostAgentRunnerRoot(): string {
  return AGENT_RUNNER_HOST_DIR;
}

export function ensureGroupIpcLayout(groupIpcDir: string): void {
  for (const subdir of IPC_GROUP_SUBDIRS) {
    fs.mkdirSync(path.join(groupIpcDir, subdir), { recursive: true });
  }
}
