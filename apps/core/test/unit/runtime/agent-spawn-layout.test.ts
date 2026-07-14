import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeTmpRoot(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-layout-'));
  roots.push(root);
  return root;
}

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('ensureWorkspaceIpcLayout', () => {
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

    const { ensureWorkspaceIpcLayout } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureWorkspaceIpcLayout(ipcDir);

    expect(fs.readdirSync(ipcDir).sort()).toEqual([
      'browser-requests',
      'browser-responses',
      'conversation-history-requests',
      'conversation-history-responses',
      'input',
      'interaction-boundaries',
      'memory-requests',
      'memory-responses',
      'messages',
      'permission-requests',
      'permission-responses',
      'rich-interactions',
      'task-responses',
      'tasks',
      'user-answers',
      'user-questions',
    ]);
    expect(fileMode(ipcDir)).toBe(0o700);
    for (const name of fs.readdirSync(ipcDir)) {
      expect(fileMode(path.join(ipcDir, name))).toBe(0o700);
    }
  });

  it('is idempotent', async () => {
    const root = makeTmpRoot(roots);
    const ipcDir = path.join(root, 'ipc-idem');

    const { ensureWorkspaceIpcLayout } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureWorkspaceIpcLayout(ipcDir);
    ensureWorkspaceIpcLayout(ipcDir);

    expect(fs.statSync(path.join(ipcDir, 'messages')).isDirectory()).toBe(true);
  });

  it('skips the workspace IPC layout for inline runtime', async () => {
    const root = makeTmpRoot(roots);
    const ipcDir = path.join(root, 'inline-ipc');

    const { ensureWorkspaceIpcLayout } =
      await import('@core/runtime/agent-spawn-layout.js');
    ensureWorkspaceIpcLayout(ipcDir, 'inline');

    expect(fs.existsSync(ipcDir)).toBe(false);
  });
});

describe('resolvePackageRootFromSourceDir', () => {
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

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      '{"name":"@gantry/core"}',
    );

    const { resolvePackageRootFromSourceDir } =
      await import('@core/platform/package-root.js');

    expect(resolvePackageRootFromSourceDir(sourceDir)).toBe(repoRoot);
  });

  it('finds the repo root from the compiled dist runtime path', async () => {
    const repoRoot = makeTmpRoot(roots);
    const distRuntimeDir = path.join(repoRoot, 'dist', 'runtime');

    fs.mkdirSync(distRuntimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      '{"name":"@gantry/core"}',
    );

    const { resolvePackageRootFromSourceDir } =
      await import('@core/platform/package-root.js');

    expect(resolvePackageRootFromSourceDir(distRuntimeDir)).toBe(repoRoot);
  });

  it('does not generate shared durable Claude files during layout import', async () => {
    const root = makeTmpRoot(roots);
    await import('@core/runtime/agent-spawn-layout.js');

    expect(fs.existsSync(path.join(root, '.claude', 'settings.json'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(root, '.claude', 'skills'))).toBe(false);
  });
});
