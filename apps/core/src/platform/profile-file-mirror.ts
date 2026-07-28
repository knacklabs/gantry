import fs from 'fs';
import fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'path';

import { logger } from '../infrastructure/logging/logger.js';
import { getRuntimeLayoutPaths } from './runtime-layout.js';
import { resolveWorkspaceFolderPath } from './workspace-folder.js';
import { isValidWorkspaceFolder } from './workspace-folder-rules.js';

// Visible, human-facing mirrors of the durable profile FileArtifacts. The
// mirror is one-way (artifact -> disk): editor changes here are NOT auto
// imported; durability flows only through the reviewed profile update path.

// Prepended to every mirror file so a user who opens it understands edits are
// inert until imported/approved. Stripped before content becomes durable.
export const PROFILE_MIRROR_HEADER =
  '<!-- Managed by Gantry. Direct edits are not active until imported or approved. -->';

const lastMirroredVersionByTarget = new Map<string, number>();
const mirrorWriteChainByTarget = new Map<string, Promise<void>>();

export function stripProfileMirrorHeader(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith(PROFILE_MIRROR_HEADER)) return content;
  return normalized
    .slice(PROFILE_MIRROR_HEADER.length)
    .replace(/^\r?\n\r?\n?/, '');
}

function assertSimpleFileName(fileName: string): void {
  if (
    !fileName ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..')
  ) {
    throw new Error(`Invalid profile mirror file name "${fileName}"`);
  }
}

export function profileMirrorFileName(fileName: string): string {
  assertSimpleFileName(fileName);
  return fileName === 'AGENTS.md' ? 'AGENTS.profile.md' : fileName;
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

function resolveProfileMirrorDir(
  agentFolder: string,
  runtimeHome?: string,
): string {
  if (!isValidWorkspaceFolder(agentFolder)) {
    throw new Error(`Invalid workspace folder "${agentFolder}"`);
  }
  const home = runtimeHome?.trim();
  if (!home) return resolveWorkspaceFolderPath(agentFolder);
  const agentsDir = getRuntimeLayoutPaths(home).agentsDir;
  const dir = path.resolve(agentsDir, agentFolder);
  ensureWithinBase(agentsDir, dir);
  return dir;
}

export function createProfileFileMirrorWriter(
  runtimeHome: string,
): typeof writeProfileFileMirror {
  return (input) => writeProfileFileMirror({ ...input, runtimeHome });
}

export function createProfileFileMirrorExists(
  runtimeHome: string,
): typeof profileFileMirrorExists {
  return (input) => profileFileMirrorExists({ ...input, runtimeHome });
}

export function profileMirrorPath(
  agentFolder: string,
  fileName: string,
  options: { runtimeHome?: string } = {},
): string {
  const mirrorFileName = profileMirrorFileName(fileName);
  const dir = resolveProfileMirrorDir(agentFolder, options.runtimeHome);
  return path.join(dir, mirrorFileName);
}

export async function writeProfileFileMirror(input: {
  agentFolder: string;
  fileName: string;
  content: string;
  version?: number;
  runtimeHome?: string;
}): Promise<void> {
  const dir = resolveProfileMirrorDir(input.agentFolder, input.runtimeHome);
  const mirrorFileName = profileMirrorFileName(input.fileName);
  const targetPath = path.resolve(dir, mirrorFileName);
  const previousWrite =
    mirrorWriteChainByTarget.get(targetPath) ?? Promise.resolve();
  const write = previousWrite.then(async () => {
    const lastMirroredVersion = lastMirroredVersionByTarget.get(targetPath);
    if (
      input.version !== undefined &&
      lastMirroredVersion !== undefined &&
      input.version <= lastMirroredVersion
    ) {
      logger.debug(
        {
          targetPath,
          version: input.version,
          lastMirroredVersion,
        },
        'skipping stale profile mirror write',
      );
      return;
    }

    await writeProfileFileMirrorAtomic({
      dir,
      mirrorFileName,
      targetPath,
      content: input.content,
    });
    if (input.version !== undefined) {
      lastMirroredVersionByTarget.set(targetPath, input.version);
    }
  });
  const settledWrite = write.then(
    () => undefined,
    () => undefined,
  );
  mirrorWriteChainByTarget.set(targetPath, settledWrite);
  void settledWrite.then(() => {
    if (mirrorWriteChainByTarget.get(targetPath) === settledWrite) {
      mirrorWriteChainByTarget.delete(targetPath);
    }
  });
  return write;
}

async function writeProfileFileMirrorAtomic(input: {
  dir: string;
  mirrorFileName: string;
  targetPath: string;
  content: string;
}): Promise<void> {
  const { dir, mirrorFileName, targetPath } = input;
  try {
    const existingDirStat = await fsp.lstat(dir);
    if (!existingDirStat.isDirectory() || existingDirStat.isSymbolicLink()) {
      throw new Error(
        `Profile mirror directory is not a safe directory: ${dir}`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await fsp.lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Profile mirror directory is not a safe directory: ${dir}`);
  }
  const tmpPath = path.join(
    dir,
    `.${mirrorFileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  const body = stripProfileMirrorHeader(input.content);
  const rendered = `${PROFILE_MIRROR_HEADER}\n\n${body}`;
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(tmpPath, 'wx', 0o600);
    await handle.writeFile(rendered, 'utf-8');
    await handle.close();
    handle = null;
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function profileFileMirrorExists(input: {
  agentFolder: string;
  fileName: string;
  runtimeHome?: string;
}): Promise<boolean> {
  const targetPath = profileMirrorPath(input.agentFolder, input.fileName, {
    runtimeHome: input.runtimeHome,
  });
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function readProfileFileMirror(input: {
  agentFolder: string;
  fileName: string;
  runtimeHome?: string;
}): string | null {
  const targetPath = profileMirrorPath(input.agentFolder, input.fileName, {
    runtimeHome: input.runtimeHome,
  });
  try {
    return fs.readFileSync(targetPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
