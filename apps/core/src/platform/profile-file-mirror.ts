import fs from 'fs';
import { constants as fsConstants } from 'fs';
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

const mirrorWriteChainByTarget = new Map<string, Promise<void>>();

const PROFILE_MIRROR_VERSION_TAIL_BYTES = 1024;

// Tolerate a trailing line ending after the marker: these are human-facing
// workspace files, and an editor or formatter appending the conventional final
// newline must not silently disable the ordering guard.
const PROFILE_MIRROR_MARKER_PATTERN =
  /\r?\n<!-- gantry-profile-version: ([^\r\n]*?) -->\r?\n?$/;

function parseProfileMirrorVersion(content: string): number | undefined {
  const match = PROFILE_MIRROR_MARKER_PATTERN.exec(content);
  const raw = match?.[1];
  if (raw === undefined || raw === 'none') return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return undefined;
  const version = Number(raw);
  return Number.isSafeInteger(version) ? version : undefined;
}

async function readRecordedMirrorVersion(
  targetPath: string,
): Promise<number | undefined> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(targetPath, profileMirrorReadOpenFlags());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(
        `Profile mirror target is not a regular file: ${targetPath}`,
      );
    }
    const length = Math.min(stat.size, PROFILE_MIRROR_VERSION_TAIL_BYTES);
    const position = stat.size - length;
    const tail = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(
        tail,
        bytesRead,
        length - bytesRead,
        position + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return parseProfileMirrorVersion(
      tail.subarray(0, bytesRead).toString('utf-8'),
    );
  } finally {
    await handle.close();
  }
}

function profileMirrorReadOpenFlags(): number {
  // O_NOFOLLOW guards the FINAL component, which is all we need here: the
  // containing directory is validated separately by
  // ensureSafeProfileMirrorDirectory. Do NOT use darwin's O_NOFOLLOW_ANY — it
  // rejects a symlink anywhere in the path, and macOS temp dirs live under
  // /var/folders where /var itself is a symlink to /private/var, so ordinary
  // files fail with ELOOP.
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return (
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
    );
  }
  throw new Error(
    'Profile mirror version reads are unsupported on this platform',
  );
}

export function stripProfileMirrorMarker(content: string): string {
  return content.replace(PROFILE_MIRROR_MARKER_PATTERN, '');
}

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
    await ensureSafeProfileMirrorDirectory(dir);
    const recordedVersion = await readRecordedMirrorVersion(targetPath);
    if (
      input.version !== undefined &&
      recordedVersion !== undefined &&
      input.version <= recordedVersion
    ) {
      logger.debug(
        {
          targetPath,
          version: input.version,
          recordedVersion,
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
      version: input.version,
    });
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
  version?: number;
}): Promise<void> {
  const { dir, mirrorFileName, targetPath } = input;
  await ensureSafeProfileMirrorDirectory(dir);
  const tmpPath = path.join(
    dir,
    `.${mirrorFileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  const body = stripProfileMirrorHeader(input.content);
  const markerVersion = input.version ?? 'none';
  const marker = `\n<!-- gantry-profile-version: ${markerVersion} -->`;
  const rendered = `${PROFILE_MIRROR_HEADER}\n\n${body}${marker}`;
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
    return stripProfileMirrorMarker(fs.readFileSync(targetPath, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
