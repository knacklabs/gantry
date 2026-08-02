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

interface MirrorWriteChain {
  tail: Promise<void>;
  // Highest version SUCCESSFULLY written by this chain.
  appliedVersion?: number;
  // Highest version ever ENQUEUED on this chain, recorded synchronously at call
  // time. Tracked separately from appliedVersion so that a newer write which
  // FAILS still blocks an older write queued behind it — otherwise appliedVersion
  // stays unset and the stale write is let through.
  highestSeenVersion?: number;
}

const mirrorWriteChainByTarget = new Map<string, MirrorWriteChain>();

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
  let chain = mirrorWriteChainByTarget.get(targetPath);
  if (!chain) {
    chain = { tail: Promise.resolve() };
    mirrorWriteChainByTarget.set(targetPath, chain);
  }
  if (input.version !== undefined) {
    chain.highestSeenVersion =
      chain.highestSeenVersion === undefined
        ? input.version
        : Math.max(chain.highestSeenVersion, input.version);
  }
  const previousWrite = chain.tail;
  const write = previousWrite.then(async () => {
    await ensureSafeProfileMirrorDirectory(dir);
    if (input.version !== undefined) {
      // Below a newer version already queued (even if that one failed), or at/below
      // one already written. `<` on highestSeen leaves an equal-version retry after
      // a failed write free to proceed.
      const belowHighestSeen =
        chain.highestSeenVersion !== undefined &&
        input.version < chain.highestSeenVersion;
      const alreadyApplied =
        chain.appliedVersion !== undefined &&
        input.version <= chain.appliedVersion;
      if (belowHighestSeen || alreadyApplied) {
        logger.debug(
          {
            targetPath,
            version: input.version,
            appliedVersion: chain.appliedVersion,
            highestSeenVersion: chain.highestSeenVersion,
          },
          'skipping stale profile mirror write',
        );
        return;
      }
    }

    await writeProfileFileMirrorAtomic({
      dir,
      mirrorFileName,
      targetPath,
      content: input.content,
    });
    if (input.version !== undefined) {
      chain.appliedVersion = input.version;
    }
  });
  const settledWrite = write.then(
    () => undefined,
    () => undefined,
  );
  chain.tail = settledWrite;
  void settledWrite.then(() => {
    if (
      mirrorWriteChainByTarget.get(targetPath) === chain &&
      chain.tail === settledWrite
    ) {
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
  await ensureSafeProfileMirrorDirectory(dir);
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

async function ensureSafeProfileMirrorDirectory(dir: string): Promise<void> {
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
