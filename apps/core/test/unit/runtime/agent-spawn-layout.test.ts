import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Helper: create a temp dir and register it for cleanup. */
function makeTmpRoot(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-layout-'));
  roots.push(root);
  return root;
}

// ---------- ensureSharedSessionSettings ----------

describe('ensureSharedSessionSettings', () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates existing settings file to enforce deterministic env keys', async () => {
    const root = makeTmpRoot(roots);

    const claudeDir = path.join(root, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CUSTOM_FLAG: 'keep-me',
          },
          custom: true,
        },
        null,
        2,
      ),
    );

    // Mock AGENT_ROOT to point to our temp root
    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: root,
      DATA_DIR: root,
    }));

    const { ensureSharedSessionSettings } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureSharedSessionSettings();

    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      env: Record<string, string>;
      custom: boolean;
    };

    expect(updated.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('0');
    expect(updated.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(updated.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
    expect(updated.env.CUSTOM_FLAG).toBe('keep-me');
    expect(updated.custom).toBe(true);
  });

  it('creates settings from scratch when no file exists', async () => {
    const root = makeTmpRoot(roots);

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: root,
      DATA_DIR: root,
    }));

    const { ensureSharedSessionSettings } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureSharedSessionSettings();

    const settingsPath = path.join(root, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      env: Record<string, string>;
    };
    expect(written.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(written.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('0');
    expect(written.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
  });

  it('recovers from malformed JSON in existing settings file', async () => {
    const root = makeTmpRoot(roots);

    const claudeDir = path.join(root, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, '{{not valid json}}');

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: root,
      DATA_DIR: root,
    }));

    const { ensureSharedSessionSettings } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureSharedSessionSettings();

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      env: Record<string, string>;
    };
    // Should fall back to empty and still write defaults
    expect(written.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(written.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('0');
    expect(written.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
    // Should have no extra keys beyond env
    expect(Object.keys(written)).toEqual(['env']);
  });

  it('treats non-object existing settings as empty', async () => {
    const root = makeTmpRoot(roots);

    const claudeDir = path.join(root, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    // A valid JSON value that is not an object
    fs.writeFileSync(settingsPath, '"just a string"');

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: root,
      DATA_DIR: root,
    }));

    const { ensureSharedSessionSettings } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureSharedSessionSettings();

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      env: Record<string, string>;
    };
    expect(written.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(Object.keys(written)).toEqual(['env']);
  });
});

// ---------- syncGroupSkills ----------

describe('syncGroupSkills', () => {
  const roots: string[] = [];
  let originalCwd: string;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore cwd
    if (originalCwd) process.chdir(originalCwd);
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bundled commands skill does not advertise removed MyClaw skill commands', () => {
    const commandsSkill = fs.readFileSync(
      path.join(process.cwd(), '.claude', 'skills', 'commands', 'SKILL.md'),
      'utf-8',
    );

    expect(commandsSkill).toContain('## MyClaw Session Commands');
    expect(commandsSkill).toContain('## Built-In Memory Behavior');
    expect(commandsSkill).not.toMatch(/`\/setup`/);
    expect(commandsSkill).not.toMatch(/`\/customize`/);
    expect(commandsSkill).not.toMatch(/`\/debug`/);
    expect(commandsSkill).not.toMatch(/`\/update-myclaw`/);
    expect(commandsSkill).not.toMatch(/`\/init-onecli`/);
    expect(commandsSkill).not.toMatch(/`\/add-telegram`/);
  });

  it('migrates an existing symlink to a real directory', async () => {
    const configRoot = makeTmpRoot(roots);
    const cwdRoot = makeTmpRoot(roots);
    originalCwd = process.cwd();

    // Create a symlink at the skills destination
    const claudeDir = path.join(configRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const skillsDst = path.join(claudeDir, 'skills');
    // Create a target for the symlink
    const symlinkTarget = path.join(configRoot, 'old-skills-target');
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.symlinkSync(symlinkTarget, skillsDst);
    expect(fs.lstatSync(skillsDst).isSymbolicLink()).toBe(true);

    process.chdir(cwdRoot);

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: configRoot,
      DATA_DIR: configRoot,
    }));

    const { syncGroupSkills } =
      await import('@core/runtime/agent-spawn-layout.js');
    syncGroupSkills();

    // Symlink should be replaced with a real directory
    const stat = fs.lstatSync(skillsDst);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates skills dir when it does not exist', async () => {
    const configRoot = makeTmpRoot(roots);
    const cwdRoot = makeTmpRoot(roots);
    originalCwd = process.cwd();
    process.chdir(cwdRoot);

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: configRoot,
      DATA_DIR: configRoot,
    }));

    const { syncGroupSkills } =
      await import('@core/runtime/agent-spawn-layout.js');
    syncGroupSkills();

    const skillsDst = path.join(configRoot, '.claude', 'skills');
    expect(fs.existsSync(skillsDst)).toBe(true);
    expect(fs.statSync(skillsDst).isDirectory()).toBe(true);
  });

  it('preserves existing skills in the directory', async () => {
    const configRoot = makeTmpRoot(roots);
    const cwdRoot = makeTmpRoot(roots);
    originalCwd = process.cwd();

    // Pre-create a skill in the destination
    const skillDir = path.join(configRoot, '.claude', 'skills', 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill');

    process.chdir(cwdRoot);

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: configRoot,
      DATA_DIR: configRoot,
    }));

    const { syncGroupSkills } =
      await import('@core/runtime/agent-spawn-layout.js');
    syncGroupSkills();

    // Existing skill should be untouched
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# My Skill',
    );
  });

  it('removes managed skills that are no longer bundled', async () => {
    const configRoot = makeTmpRoot(roots);
    const cwdRoot = makeTmpRoot(roots);
    originalCwd = process.cwd();

    const removedSkill = ['setup', 'mini', 'app'].join('-');
    const skillDir = path.join(configRoot, '.claude', 'skills', removedSkill);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.version'), '1.2.51\n');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Removed Skill');

    process.chdir(cwdRoot);

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: configRoot,
      DATA_DIR: configRoot,
    }));

    const { syncGroupSkills } =
      await import('@core/runtime/agent-spawn-layout.js');
    syncGroupSkills();

    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it('installs bundled skills with a version marker', async () => {
    const configRoot = makeTmpRoot(roots);
    const cwdRoot = makeTmpRoot(roots);
    originalCwd = process.cwd();
    process.chdir(cwdRoot);

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: configRoot,
      DATA_DIR: configRoot,
    }));

    const packageVersion = JSON.parse(
      fs.readFileSync(path.join(originalCwd, 'package.json'), 'utf-8'),
    ).version as string;

    const { syncGroupSkills } =
      await import('@core/runtime/agent-spawn-layout.js');
    syncGroupSkills();

    const versionPath = path.join(
      configRoot,
      '.claude',
      'skills',
      'commands',
      '.version',
    );
    expect(fs.existsSync(versionPath)).toBe(true);
    expect(fs.readFileSync(versionPath, 'utf-8').trim()).toBe(packageVersion);
  });

  it('updates a versioned bundled skill when package version is newer', async () => {
    const configRoot = makeTmpRoot(roots);
    const cwdRoot = makeTmpRoot(roots);
    originalCwd = process.cwd();
    process.chdir(cwdRoot);

    const skillDir = path.join(configRoot, '.claude', 'skills', 'commands');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# stale');
    fs.writeFileSync(path.join(skillDir, '.version'), '0.0.1\n');

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: configRoot,
      DATA_DIR: configRoot,
    }));

    const packageVersion = JSON.parse(
      fs.readFileSync(path.join(originalCwd, 'package.json'), 'utf-8'),
    ).version as string;
    const bundledSkill = fs.readFileSync(
      path.join(originalCwd, '.claude', 'skills', 'commands', 'SKILL.md'),
      'utf-8',
    );

    const { syncGroupSkills } =
      await import('@core/runtime/agent-spawn-layout.js');
    syncGroupSkills();

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
      bundledSkill,
    );
    expect(
      fs.readFileSync(path.join(skillDir, '.version'), 'utf-8').trim(),
    ).toBe(packageVersion);
  });

  it('stamps unversioned bundled skills without overwriting existing content', async () => {
    const configRoot = makeTmpRoot(roots);
    const cwdRoot = makeTmpRoot(roots);
    originalCwd = process.cwd();
    process.chdir(cwdRoot);

    const skillDir = path.join(configRoot, '.claude', 'skills', 'commands');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Custom Skill');

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: configRoot,
      DATA_DIR: configRoot,
    }));

    const packageVersion = JSON.parse(
      fs.readFileSync(path.join(originalCwd, 'package.json'), 'utf-8'),
    ).version as string;

    const { syncGroupSkills } =
      await import('@core/runtime/agent-spawn-layout.js');
    syncGroupSkills();

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# My Custom Skill',
    );
    expect(
      fs.readFileSync(path.join(skillDir, '.version'), 'utf-8').trim(),
    ).toBe(packageVersion);
  });
});

// ---------- ensureGroupIpcLayout ----------

describe('ensureGroupIpcLayout', () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates all IPC subdirectories', async () => {
    const root = makeTmpRoot(roots);
    const ipcDir = path.join(root, 'group-ipc');

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: root,
      DATA_DIR: root,
    }));

    const { ensureGroupIpcLayout } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureGroupIpcLayout(ipcDir);

    const expected = [
      'browser-requests',
      'browser-responses',
      'input',
      'memory-requests',
      'memory-responses',
      'messages',
      'permission-requests',
      'permission-responses',
      'task-responses',
      'tasks',
      'user-answers',
      'user-questions',
    ];

    for (const sub of expected) {
      const fullPath = path.join(ipcDir, sub);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.statSync(fullPath).isDirectory()).toBe(true);
    }

    // Exactly these directories and nothing else
    const actual = fs.readdirSync(ipcDir).sort();
    expect(actual).toEqual(expected);
  });

  it('is idempotent — calling twice does not error', async () => {
    const root = makeTmpRoot(roots);
    const ipcDir = path.join(root, 'ipc-idem');

    vi.doMock('@core/core/config.js', () => ({
      AGENT_ROOT: root,
      DATA_DIR: root,
    }));

    const { ensureGroupIpcLayout } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureGroupIpcLayout(ipcDir);
    // Second call should not throw
    ensureGroupIpcLayout(ipcDir);

    expect(fs.readdirSync(ipcDir).sort()).toEqual([
      'browser-requests',
      'browser-responses',
      'input',
      'memory-requests',
      'memory-responses',
      'messages',
      'permission-requests',
      'permission-responses',
      'task-responses',
      'tasks',
      'user-answers',
      'user-questions',
    ]);
  });
});

describe('resolveRepoRootFromSourceDir', () => {
  const roots: string[] = [];
  let originalCwd: string;

  beforeEach(() => {
    vi.resetModules();
    originalCwd = process.cwd();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds the repo root from the source-tree runtime path', async () => {
    const repoRoot = makeTmpRoot(roots);
    const sourceDir = path.join(repoRoot, 'apps', 'core', 'src', 'runtime');

    fs.mkdirSync(path.join(repoRoot, 'packages', 'agent-runner'), {
      recursive: true,
    });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"myclaw"}');

    const { resolveRepoRootFromSourceDir } =
      await import('@core/runtime/agent-spawn-layout.js');

    expect(resolveRepoRootFromSourceDir(sourceDir)).toBe(repoRoot);
  });

  it('finds the repo root from the compiled dist runtime path', async () => {
    const repoRoot = makeTmpRoot(roots);
    const distRuntimeDir = path.join(repoRoot, 'dist', 'runtime');

    fs.mkdirSync(path.join(repoRoot, 'packages', 'agent-runner'), {
      recursive: true,
    });
    fs.mkdirSync(distRuntimeDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"myclaw"}');

    const { resolveRepoRootFromSourceDir } =
      await import('@core/runtime/agent-spawn-layout.js');

    expect(resolveRepoRootFromSourceDir(distRuntimeDir)).toBe(repoRoot);
  });
});
