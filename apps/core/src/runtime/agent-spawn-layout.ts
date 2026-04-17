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
const AGENT_RUNNER_SOURCE_DIR = path.join(
  REPO_ROOT,
  'packages',
  'agent-runner',
);
const AGENT_RUNNER_RUNTIME_DIR = path.join(
  AGENT_ROOT,
  '.runtime',
  'agent-runner',
);
const REPO_NODE_MODULES_DIR = path.join(REPO_ROOT, 'node_modules');
const AGENT_RUNNER_SDK_PACKAGE_PATH = path.join(
  '@anthropic-ai',
  'claude-agent-sdk',
  'package.json',
);
const AGENT_RUNNER_REQUIRED_FILES = [
  path.join('dist', 'index.js'),
  path.join('dist', 'ipc-mcp-stdio.js'),
  path.join('node_modules', AGENT_RUNNER_SDK_PACKAGE_PATH),
];
const BUNDLED_SKILL_VERSION_FILENAME = '.version';
const REMOVED_BUNDLED_SKILLS = new Set([['setup', 'mini', 'app'].join('-')]);

let lastRunnerSyncSignature: string | null = null;

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

function resolveAgentRunnerDependencyRoot(): string | null {
  const candidateRoots = [
    REPO_NODE_MODULES_DIR,
    path.join(AGENT_RUNNER_SOURCE_DIR, 'node_modules'),
  ];
  for (const candidate of candidateRoots) {
    if (!fs.existsSync(candidate)) continue;
    if (fs.existsSync(path.join(candidate, AGENT_RUNNER_SDK_PACKAGE_PATH))) {
      return candidate;
    }
  }
  return null;
}

function ensureRuntimeAgentRunnerDependencies(): void {
  const runtimeNodeModulesDir = path.join(
    AGENT_RUNNER_RUNTIME_DIR,
    'node_modules',
  );
  const dependencyRoot = resolveAgentRunnerDependencyRoot();
  if (!dependencyRoot) {
    return;
  }

  try {
    const stat = fs.lstatSync(runtimeNodeModulesDir);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(runtimeNodeModulesDir);
      if (
        path.resolve(AGENT_RUNNER_RUNTIME_DIR, currentTarget) === dependencyRoot
      ) {
        return;
      }
    }
    fs.rmSync(runtimeNodeModulesDir, { recursive: true, force: true });
  } catch {
    // Runtime dependency link does not exist yet.
  }

  fs.symlinkSync(
    dependencyRoot,
    runtimeNodeModulesDir,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function hasRequiredRunnerFiles(root: string): boolean {
  return AGENT_RUNNER_REQUIRED_FILES.every((relPath) =>
    fs.existsSync(path.join(root, relPath)),
  );
}

function statMtime(pathValue: string): string {
  try {
    return String(fs.statSync(pathValue).mtimeMs);
  } catch {
    return 'missing';
  }
}

function computeRunnerSourceSignature(sourceRoot: string): string {
  const signatureParts = [
    statMtime(path.join(sourceRoot, 'package-lock.json')),
    statMtime(path.join(sourceRoot, 'package.json')),
    statMtime(path.join(sourceRoot, 'dist', 'index.js')),
    statMtime(path.join(sourceRoot, 'dist', 'ipc-mcp-stdio.js')),
  ];
  return signatureParts.join('|');
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
 * Legacy symlinks are migrated to real directories automatically.
 * Bundled skills from the package are copied if not already present.
 * Existing skills are updated only when their bundled version is older.
 */
export function syncGroupSkills(): void {
  const skillsDst = path.join(AGENT_ROOT, '.claude', 'skills');
  const bundledVersion = readPackageVersion(REPO_ROOT);

  // Migrate legacy symlink to a real directory
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
        // Legacy install without a managed version marker: preserve current
        // files and stamp the version so future upgrades are trackable.
        writeInstalledSkillVersion(dst, bundledVersion);
        logger.info(
          { skill: entry.name, version: bundledVersion },
          'Stamped bundled skill version for legacy install',
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
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

export function getRepoAgentRunnerRoot(): string {
  return AGENT_RUNNER_SOURCE_DIR;
}

export function getRuntimeAgentRunnerRoot(): string {
  return AGENT_RUNNER_RUNTIME_DIR;
}

/**
 * Keep a runtime-local copy of host runner assets under AGENT_ROOT.
 * This avoids runtime dependence on `<repo>/packages/agent-runner`
 * paths after startup.
 */
export function syncHostAgentRunnerRuntime(): string {
  fs.mkdirSync(path.dirname(AGENT_RUNNER_RUNTIME_DIR), { recursive: true });

  // If source is unavailable, rely on already-synced runtime files.
  if (!fs.existsSync(AGENT_RUNNER_SOURCE_DIR)) {
    return AGENT_RUNNER_RUNTIME_DIR;
  }

  const sourceSignature = computeRunnerSourceSignature(AGENT_RUNNER_SOURCE_DIR);
  if (
    lastRunnerSyncSignature === sourceSignature &&
    hasRequiredRunnerFiles(AGENT_RUNNER_RUNTIME_DIR)
  ) {
    return AGENT_RUNNER_RUNTIME_DIR;
  }

  fs.cpSync(AGENT_RUNNER_SOURCE_DIR, AGENT_RUNNER_RUNTIME_DIR, {
    recursive: true,
    force: true,
  });
  ensureRuntimeAgentRunnerDependencies();
  lastRunnerSyncSignature = sourceSignature;
  logger.debug(
    { source: AGENT_RUNNER_SOURCE_DIR, destination: AGENT_RUNNER_RUNTIME_DIR },
    'Synchronized host MyClaw agent runner runtime assets',
  );
  return AGENT_RUNNER_RUNTIME_DIR;
}

export function ensureGroupIpcLayout(groupIpcDir: string): void {
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'memory-requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'memory-responses'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'browser-requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'browser-responses'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'permission-requests'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'permission-responses'), {
    recursive: true,
  });
}
