import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PRIVATE_FILE_MODE } from './private-fs.js';

// macOS 11+ defines O_NOFOLLOW_ANY, but Node does not export it.
const O_NOFOLLOW_ANY = 0x20000000;
const MAX_FILE_COMPONENT_BYTES = 255;
const STORAGE_ID_PREFIX_BYTES = 17;
const TEMP_NAME_WRAPPER_BYTES = 1 + 1 + 32 + 4;
const MAX_STORAGE_FILENAME_BYTES =
  MAX_FILE_COMPONENT_BYTES - STORAGE_ID_PREFIX_BYTES - TEMP_NAME_WRAPPER_BYTES;

export interface InboundAttachmentReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
}

export type InboundAttachmentWriteResult =
  | { status: 'written'; bytes: number }
  | { status: 'too-large'; bytes: number };

export function createInboundAttachmentStorageRef(filename: string): string {
  const sanitized = filename.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeName =
    sanitized && sanitized !== '.' && sanitized !== '..'
      ? sanitized
      : 'attachment.bin';
  const boundedName = truncateFilenamePreservingExtension(
    safeName,
    MAX_STORAGE_FILENAME_BYTES,
  );
  return path.posix.join(
    'attachments',
    `${randomBytes(8).toString('hex')}-${boundedName}`,
  );
}

export async function writeInboundAttachment(input: {
  workspaceRoot: string;
  workspaceRelativePath: string;
  content: Uint8Array | InboundAttachmentReader;
  maxBytes: number;
}): Promise<InboundAttachmentWriteResult> {
  if (!isSafeWorkspaceRelativePath(input.workspaceRelativePath)) {
    throw new Error('Invalid inbound attachment path');
  }

  const workspaceRoot = await fs.realpath(input.workspaceRoot);
  const requestedPath = path.resolve(
    workspaceRoot,
    input.workspaceRelativePath,
  );
  assertContained(workspaceRoot, requestedPath);

  const directoryPath = await fs.realpath(path.dirname(requestedPath));
  assertContained(workspaceRoot, directoryPath);
  const finalName = path.basename(requestedPath);
  const directory = await openContainedDirectory(directoryPath);
  const tempName = `.${finalName}.${randomBytes(16).toString('hex')}.tmp`;
  let temp: Awaited<ReturnType<typeof fs.open>> | null = null;

  try {
    temp = await fs.open(
      directoryEntryPath(directory, directoryPath, tempName),
      fileOpenFlags(fsConstants.O_RDWR),
      PRIVATE_FILE_MODE,
    );
    await assertOpenedFileBinding({
      directory,
      directoryPath,
      file: temp,
      fileName: tempName,
    });

    const result = isInboundAttachmentReader(input.content)
      ? await writeStream(temp, input.content, input.maxBytes)
      : await writeBuffer(temp, input.content, input.maxBytes);
    if (result.status === 'too-large') return result;

    await temp.chmod(PRIVATE_FILE_MODE);
    await temp.sync();
    await assertOpenedFileBinding({
      directory,
      directoryPath,
      file: temp,
      fileName: tempName,
    });
    await fs.rename(
      directoryEntryPath(directory, directoryPath, tempName),
      directoryEntryPath(directory, directoryPath, finalName),
    );
    return result;
  } finally {
    try {
      if (temp) {
        try {
          // ponytail: Node exposes no portable *at unlink on Darwin; random temp names plus directory-descriptor validation are the mitigation for path-based cleanup.
          await removeBoundFile(directory, directoryPath, temp, tempName);
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        } finally {
          await temp.close();
        }
      }
    } finally {
      await directory.close();
    }
  }
}

async function openContainedDirectory(
  directoryPath: string,
): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const directory = await fs.open(directoryPath, directoryOpenFlags());
  try {
    await assertOpenedDirectoryBinding(directory, directoryPath);
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function assertOpenedDirectoryBinding(
  directory: Awaited<ReturnType<typeof fs.open>>,
  directoryPath: string,
): Promise<void> {
  const descriptorStat = await directory.stat();
  const pathStat = await fs.lstat(directoryPath);
  if (
    !descriptorStat.isDirectory() ||
    !pathStat.isDirectory() ||
    pathStat.isSymbolicLink() ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino
  ) {
    throw new Error('Inbound attachment directory changed during write');
  }

  if (process.platform === 'linux') {
    const descriptorPath = await fs.realpath(`/proc/self/fd/${directory.fd}`);
    if (descriptorPath !== directoryPath) {
      throw new Error('Inbound attachment directory changed during write');
    }
  }
}

async function assertOpenedFileBinding(input: {
  directory: Awaited<ReturnType<typeof fs.open>>;
  directoryPath: string;
  file: Awaited<ReturnType<typeof fs.open>>;
  fileName: string;
}): Promise<void> {
  if (process.platform === 'darwin') {
    await assertOpenedDirectoryBinding(input.directory, input.directoryPath);
  }
  const descriptorStat = await input.file.stat();
  const entryPath = directoryEntryPath(
    input.directory,
    input.directoryPath,
    input.fileName,
  );
  const pathStat = await fs.lstat(entryPath);
  if (
    !descriptorStat.isFile() ||
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino ||
    descriptorStat.nlink !== 1
  ) {
    throw new Error('Inbound attachment file changed during write');
  }

  if (process.platform === 'linux') {
    const descriptorPath = await fs.realpath(`/proc/self/fd/${input.file.fd}`);
    const entryRealPath = await fs.realpath(entryPath);
    if (descriptorPath !== entryRealPath) {
      throw new Error('Inbound attachment file changed during write');
    }
  }
}

async function removeBoundFile(
  directory: Awaited<ReturnType<typeof fs.open>>,
  directoryPath: string,
  file: Awaited<ReturnType<typeof fs.open>>,
  fileName: string,
): Promise<void> {
  await assertOpenedFileBinding({
    directory,
    directoryPath,
    file,
    fileName,
  });
  await fs.unlink(directoryEntryPath(directory, directoryPath, fileName));
}

async function writeBuffer(
  file: Awaited<ReturnType<typeof fs.open>>,
  content: Uint8Array,
  maxBytes: number,
): Promise<InboundAttachmentWriteResult> {
  if (content.byteLength > maxBytes) {
    return { status: 'too-large', bytes: content.byteLength };
  }
  await writeAll(file, content);
  return { status: 'written', bytes: content.byteLength };
}

async function writeStream(
  file: Awaited<ReturnType<typeof fs.open>>,
  reader: InboundAttachmentReader,
  maxBytes: number,
): Promise<InboundAttachmentWriteResult> {
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return { status: 'written', bytes };
    if (!chunk.value || chunk.value.byteLength === 0) continue;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) return { status: 'too-large', bytes };
    await writeAll(file, chunk.value);
  }
}

async function writeAll(
  file: Awaited<ReturnType<typeof fs.open>>,
  content: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < content.byteLength) {
    const { bytesWritten } = await file.write(
      content,
      offset,
      content.byteLength - offset,
    );
    if (bytesWritten === 0) {
      throw new Error('Failed to write inbound attachment');
    }
    offset += bytesWritten;
  }
}

function directoryOpenFlags(): number {
  if (process.platform === 'darwin') {
    return fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | O_NOFOLLOW_ANY;
  }
  if (process.platform === 'linux') {
    return (
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
  }
  throw new Error('Inbound attachment writes are unsupported on this platform');
}

function fileOpenFlags(accessMode: number): number {
  const noFollow =
    process.platform === 'darwin'
      ? O_NOFOLLOW_ANY
      : process.platform === 'linux'
        ? fsConstants.O_NOFOLLOW
        : directoryOpenFlags();
  return accessMode | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
}

function directoryEntryPath(
  directory: Awaited<ReturnType<typeof fs.open>>,
  directoryPath: string,
  fileName: string,
): string {
  if (process.platform === 'linux') {
    return `/proc/self/fd/${directory.fd}/${fileName}`;
  }
  if (process.platform === 'darwin') {
    return path.join(directoryPath, fileName);
  }
  throw new Error('Inbound attachment writes are unsupported on this platform');
}

function assertContained(rootPath: string, candidatePath: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Inbound attachment path escapes the workspace');
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function truncateFilenamePreservingExtension(
  filename: string,
  maxBytes: number,
): string {
  if (Buffer.byteLength(filename) <= maxBytes) return filename;

  const extension = path.posix.extname(filename);
  if (!extension) return truncateEncodedPrefix(filename, maxBytes);

  const extensionBytes = Buffer.byteLength(extension);
  if (extensionBytes >= maxBytes) {
    return truncateEncodedPrefix(extension, maxBytes);
  }
  const stem = filename.slice(0, -extension.length);
  return `${truncateEncodedPrefix(stem, maxBytes - extensionBytes)}${extension}`;
}

function truncateEncodedPrefix(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function isSafeWorkspaceRelativePath(value: string): boolean {
  return (
    Boolean(value.trim()) &&
    !value.includes('\0') &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.split(/[\\/]/).includes('..')
  );
}

function isInboundAttachmentReader(
  value: Uint8Array | InboundAttachmentReader,
): value is InboundAttachmentReader {
  return 'read' in value;
}
