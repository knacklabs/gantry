import { inflateRawSync } from 'node:zlib';

import type { SkillArtifactAsset } from '../../domain/ports/skill-artifact-store.js';

export const MAX_SKILL_ZIP_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_FILES = 128;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;

type ZipEntry = {
  path: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttributes: number;
};

export type ParsedSkillZipUpload = {
  assets: SkillArtifactAsset[];
  fallbackName: string;
};

export function parseSkillZipUpload(input: Uint8Array): ParsedSkillZipUpload {
  const zip = Buffer.from(input);
  if (zip.byteLength === 0) {
    throw new Error('Skill zip is empty');
  }
  const entries = readCentralDirectory(zip)
    .filter((entry) => !entry.path.endsWith('/'))
    .map((entry) => ({
      ...entry,
      path: normalizeZipPath(entry.path),
    }));
  if (entries.length === 0) {
    throw new Error('Skill zip contains no files');
  }
  if (entries.length > MAX_SKILL_FILES) {
    throw new Error(`Skill zip contains too many files: ${entries.length}`);
  }

  const root = resolveSkillRoot(entries.map((entry) => entry.path));
  const assets: SkillArtifactAsset[] = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    rejectSymlink(entry);
    const strippedPath = stripRoot(entry.path, root.prefix);
    if (!strippedPath) continue;
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Skill zip uncompressed content is too large');
    }
    assets.push({
      path: strippedPath,
      content: readEntryContent(zip, entry),
      contentType: contentTypeForPath(strippedPath),
    });
  }

  if (!assets.some((asset) => asset.path === 'SKILL.md')) {
    throw new Error('Skill zip must contain SKILL.md');
  }
  return {
    assets,
    fallbackName: root.fallbackName,
  };
}

function readCentralDirectory(zip: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const totalEntries = zip.readUInt16LE(eocdOffset + 10);
  const centralSize = zip.readUInt32LE(eocdOffset + 12);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  if (
    centralOffset + centralSize > zip.byteLength ||
    centralOffset < 0 ||
    centralSize < 0
  ) {
    throw new Error('Invalid skill zip central directory');
  }

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (
      offset + 46 > zip.byteLength ||
      zip.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw new Error('Invalid skill zip central directory entry');
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > zip.byteLength) {
      throw new Error('Invalid skill zip entry name');
    }
    entries.push({
      path: zip.subarray(nameStart, nameEnd).toString('utf-8'),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttributes,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  if (zip.byteLength < 22) {
    throw new Error('Invalid skill zip: missing central directory');
  }
  const minimumOffset = Math.max(0, zip.byteLength - 65_557);
  for (let offset = zip.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('Invalid skill zip: missing central directory');
}

function normalizeZipPath(value: string): string {
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`Invalid skill zip path: ${value}`);
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid skill zip path: ${value}`);
  }
  if (
    parts.some((part) =>
      ['.DS_Store', '.git', '__MACOSX', 'node_modules'].includes(part),
    )
  ) {
    throw new Error(`Unsupported skill zip path: ${value}`);
  }
  return parts.join('/');
}

function resolveSkillRoot(paths: string[]): {
  prefix: string;
  fallbackName: string;
} {
  if (paths.includes('SKILL.md')) {
    return { prefix: '', fallbackName: 'uploaded-skill' };
  }

  const topLevel = new Set(paths.map((entryPath) => entryPath.split('/')[0]));
  if (topLevel.size !== 1) {
    throw new Error('Skill zip must contain exactly one skill root');
  }
  const [root] = [...topLevel];
  const prefix = `${root}/`;
  if (!paths.includes(`${prefix}SKILL.md`)) {
    throw new Error('Skill zip must contain SKILL.md');
  }
  return {
    prefix,
    fallbackName: root,
  };
}

function stripRoot(entryPath: string, prefix: string): string {
  if (!prefix) return entryPath;
  if (!entryPath.startsWith(prefix)) {
    throw new Error(`Skill zip path is outside skill root: ${entryPath}`);
  }
  return entryPath.slice(prefix.length);
}

function rejectSymlink(entry: ZipEntry): void {
  const unixMode = entry.externalAttributes >>> 16;
  if ((unixMode & 0o170000) === 0o120000) {
    throw new Error(`Skill zip cannot contain symlinks: ${entry.path}`);
  }
}

function readEntryContent(zip: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > zip.byteLength || zip.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Invalid skill zip local entry: ${entry.path}`);
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`Unsupported skill zip compression method: ${entry.path}`);
  }
  const nameLength = zip.readUInt16LE(offset + 26);
  const extraLength = zip.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.byteLength) {
    throw new Error(`Invalid skill zip compressed data: ${entry.path}`);
  }
  const compressed = zip.subarray(dataStart, dataEnd);
  const content =
    entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
  if (content.byteLength !== entry.uncompressedSize) {
    throw new Error(`Invalid skill zip size metadata: ${entry.path}`);
  }
  return content;
}

function contentTypeForPath(entryPath: string): string | undefined {
  if (entryPath.endsWith('.md')) return 'text/markdown';
  if (entryPath.endsWith('.json')) return 'application/json';
  if (entryPath.endsWith('.txt')) return 'text/plain';
  return undefined;
}
