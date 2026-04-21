import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLAUDE_RUNTIME_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
  },
  autoMemoryEnabled: false,
};

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolvePackageRootFromSourceDir(SOURCE_DIR);

export function resolvePackageRootFromSourceDir(sourceDir: string): string {
  let currentDir = path.resolve(sourceDir);

  while (true) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
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

function buildHookCommand(command: string): string {
  return `npx --yes ${JSON.stringify(readPackageSpec(PACKAGE_ROOT))} ${command}`;
}

function readPackageSpec(packageRoot: string): string {
  try {
    const raw = fs.readFileSync(
      path.join(packageRoot, 'package.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      version?: unknown;
    };
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    const version =
      typeof parsed.version === 'string' ? parsed.version.trim() : '';
    if (name && version) return `${name}@${version}`;
    if (name) return name;
  } catch {
    // Fall through to the public package name.
  }
  return '@myclaw/core';
}

function buildMemoryHookSettings(): Record<string, unknown> {
  return {
    SessionStart: [
      {
        matcher: 'startup|resume|compact',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand('memory-hook load'),
            timeout: 10,
          },
        ],
      },
    ],
    PreCompact: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(
              'memory-hook extract --trigger=precompact',
            ),
            timeout: 120,
            async: true,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        matcher: 'clear|resume|logout|other',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(
              'memory-hook extract --trigger=session-end',
            ),
            timeout: 120,
            async: true,
          },
        ],
      },
    ],
  };
}

export function ensureSharedSessionSettings(runtimeHome: string): void {
  const claudeDir = path.join(runtimeHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settings = {
    env: CLAUDE_RUNTIME_SETTINGS.env,
    autoMemoryEnabled: CLAUDE_RUNTIME_SETTINGS.autoMemoryEnabled,
    hooks: buildMemoryHookSettings(),
  };

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
  );
}

export function syncBundledSkills(runtimeHome: string): void {
  const skillsDst = path.join(runtimeHome, '.claude', 'skills');

  try {
    const stat = fs.lstatSync(skillsDst);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(skillsDst);
    }
  } catch {
    // Directory does not exist yet.
  }

  fs.mkdirSync(skillsDst, { recursive: true });

  const bundledSkillsDir = path.join(PACKAGE_ROOT, '.claude', 'skills');
  if (!fs.existsSync(bundledSkillsDir)) return;

  const entries = fs.readdirSync(bundledSkillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(bundledSkillsDir, entry.name);
    const dst = path.join(skillsDst, entry.name);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    copyDirRecursive(src, dst);
  }
}

export function ensureRuntimeClaudeFiles(runtimeHome: string): void {
  ensureSharedSessionSettings(runtimeHome);
  syncBundledSkills(runtimeHome);
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
