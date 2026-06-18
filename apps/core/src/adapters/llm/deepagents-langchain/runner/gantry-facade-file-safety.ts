import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

type FileFacadeToolName = 'FileRead' | 'FileEdit' | 'FileWrite';

export interface GantryFacadeWorkspaceConfig {
  cwd?: string;
}

export async function workspaceRoot(
  config: GantryFacadeWorkspaceConfig,
): Promise<string> {
  const configured =
    config.cwd?.trim() ||
    process.env.GANTRY_WORKSPACE_GROUP_DIR?.trim() ||
    process.cwd();
  return fs.realpath(configured);
}

export async function resolveExistingWorkspacePath(
  relativePath: string,
  config: GantryFacadeWorkspaceConfig,
): Promise<string> {
  const root = await workspaceRoot(config);
  const candidate = path.resolve(root, relativePath);
  ensureInsideRoot(root, candidate);
  const parent = await resolveWorkspaceParent(
    root,
    path.dirname(candidate),
    'FileRead',
    false,
  );
  const real = await fs.realpath(path.join(parent, path.basename(candidate)));
  ensureInsideRoot(root, real);
  return real;
}

export async function resolveWritableWorkspacePath(
  relativePath: string,
  config: GantryFacadeWorkspaceConfig,
  toolName: 'FileWrite' | 'FileEdit',
): Promise<string> {
  const root = await workspaceRoot(config);
  const candidate = path.resolve(root, relativePath);
  ensureInsideRoot(root, candidate);
  const parent = await resolveWorkspaceParent(
    root,
    path.dirname(candidate),
    toolName,
    toolName === 'FileWrite',
  );
  const target = path.join(parent, path.basename(candidate));
  const existingTarget = await fs.lstat(target).catch(() => null);
  if (existingTarget?.isSymbolicLink()) {
    throw new Error(`${toolName} refuses to follow symlink targets.`);
  }
  if (!existingTarget && toolName === 'FileEdit') {
    throw new Error('FileEdit target does not exist.');
  }
  if (existingTarget) {
    const real = await fs.realpath(target);
    ensureInsideRoot(root, real);
    return real;
  }
  return target;
}

export async function writeFileNoFollow(
  target: string,
  content: string,
): Promise<void> {
  const handle = await fs.open(
    target,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
    0o666,
  );
  try {
    await handle.writeFile(content, 'utf-8');
  } finally {
    await handle.close();
  }
}

async function resolveWorkspaceParent(
  root: string,
  parent: string,
  toolName: FileFacadeToolName,
  createMissing: boolean,
): Promise<string> {
  ensureInsideRoot(root, parent);
  let current = root;
  for (const part of path
    .relative(root, parent)
    .split(path.sep)
    .filter(Boolean)) {
    const next = path.join(current, part);
    const stat = await fs.lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      if (!createMissing) {
        throw new Error(`${toolName} parent directory does not exist.`);
      }
      await fs.mkdir(next);
    } else if (stat.isSymbolicLink()) {
      throw new Error(`${toolName} refuses to follow symlink path components.`);
    } else if (!stat.isDirectory()) {
      throw new Error(`${toolName} parent path is not a directory.`);
    }
    const real = await fs.realpath(next);
    ensureInsideRoot(root, real);
    current = next;
  }
  const realParent = await fs.realpath(current);
  ensureInsideRoot(root, realParent);
  return realParent;
}

function ensureInsideRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error('File path escapes the Gantry workspace.');
}
