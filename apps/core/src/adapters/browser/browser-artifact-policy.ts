import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';

const MAX_INLINE_UPLOAD_FILES = 8;
const MAX_INLINE_UPLOAD_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_UPLOAD_TOTAL_BYTES = 32 * 1024 * 1024;

export function ensureBrowserArtifactRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

export function writeBrowserArtifactFileSync(
  filename: string,
  content: Buffer | string,
  encoding?: BufferEncoding,
  options: { exclusive?: boolean } = {},
): void {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    (options.exclusive ? fs.constants.O_EXCL : 0) |
    (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filename, flags, 0o600);
  try {
    if (typeof content === 'string') {
      fs.writeFileSync(fd, content, encoding);
    } else {
      fs.writeFileSync(fd, content);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function normalizeBrowserFilePayload(
  toolName: BrowserBackendAction,
  payload: Record<string, unknown>,
  options: { fileAccessRoot: string },
): Record<string, unknown> {
  const next = { ...payload };
  const rawPathsPresent = arrayValue(next.paths).length > 0;
  if (next.filename !== undefined) {
    next.filename = resolveBrowserOutputPath(
      next.filename,
      options.fileAccessRoot,
    );
  }
  if (toolName === 'file_upload' && next.files !== undefined) {
    if (rawPathsPresent) {
      throw new Error('file_upload accepts inline files only.');
    }
    next.paths = materializeBrowserUploadFiles(
      next.files,
      options.fileAccessRoot,
    );
    delete next.files;
  }
  if ((toolName === 'file_upload' || toolName === 'drop') && rawPathsPresent) {
    throw new Error('Browser upload/drop filesystem paths are not accepted.');
  }
  if (next.paths !== undefined) {
    if (!Array.isArray(next.paths)) {
      throw new Error('Browser upload/drop paths must be an array.');
    }
    next.paths = next.paths.map((item) =>
      resolveBrowserInputFilePath(item, options.fileAccessRoot),
    );
  }
  return next;
}

function materializeBrowserUploadFiles(
  value: unknown,
  fileAccessRoot: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Browser upload/drop files must be an array.');
  }
  if (value.length > MAX_INLINE_UPLOAD_FILES) {
    throw new Error(
      `Browser inline uploads are limited to ${MAX_INLINE_UPLOAD_FILES} files.`,
    );
  }
  const requestDir = `inline-${randomUUID()}`;
  const files = value.map((item, index) =>
    parseBrowserUploadFile(item, index, requestDir, fileAccessRoot),
  );
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > MAX_INLINE_UPLOAD_TOTAL_BYTES) {
    throw new Error(
      `Browser inline uploads are limited to ${MAX_INLINE_UPLOAD_TOTAL_BYTES} decoded bytes per request.`,
    );
  }
  return files.map((file) => {
    writeBrowserArtifactFileSync(file.outputPath, file.bytes, undefined, {
      exclusive: true,
    });
    return file.outputPath;
  });
}

function parseBrowserUploadFile(
  value: unknown,
  index: number,
  requestDir: string,
  fileAccessRoot: string,
): { outputPath: string; bytes: Buffer; sizeBytes: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser upload/drop file entries must be objects.');
  }
  const row = value as Record<string, unknown>;
  const rawName = uploadFileName(row.name, index);
  const filename = path.join('uploads', requestDir, `${index + 1}-${rawName}`);
  const outputPath = resolveBrowserOutputPath(filename, fileAccessRoot);
  const content = row.content;
  if (typeof content !== 'string') {
    throw new Error('Browser upload/drop file content must be a string.');
  }
  const encoding = row.encoding === 'base64' ? 'base64' : 'utf8';
  const normalizedContent =
    encoding === 'base64' ? content.replace(/\s/g, '') : content;
  if (encoding === 'base64' && !isValidBase64(normalizedContent)) {
    throw new Error('Browser inline upload base64 content is invalid.');
  }
  const sizeBytes = Buffer.byteLength(normalizedContent, encoding);
  if (sizeBytes > MAX_INLINE_UPLOAD_FILE_BYTES) {
    throw new Error(
      `Browser inline upload files are limited to ${MAX_INLINE_UPLOAD_FILE_BYTES} decoded bytes each.`,
    );
  }
  return {
    outputPath,
    bytes: Buffer.from(normalizedContent, encoding),
    sizeBytes,
  };
}

function uploadFileName(value: unknown, index: number): string {
  const raw = stringValue(value) || `upload-${index + 1}.txt`;
  if (
    raw !== path.basename(raw) ||
    raw.includes('/') ||
    raw.includes('\\') ||
    raw === '.' ||
    raw === '..'
  ) {
    throw new Error(
      'Browser inline upload file names must be plain filenames.',
    );
  }
  return raw;
}

function isValidBase64(value: string): boolean {
  return (
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    !/=.+[^=]/.test(value)
  );
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function resolveBrowserPath(value: unknown, fileAccessRoot: string): string {
  const raw = stringValue(value);
  if (!raw) throw new Error('Browser file action requires a path.');
  const root = path.resolve(fileAccessRoot);
  const candidate = path.resolve(root, raw);
  const relative = path.relative(root, candidate);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      'Browser file actions are limited to the run browser artifact root.',
    );
  }
  const segments = relative.split(path.sep);
  if (segments.some(isSensitivePathSegment)) {
    throw new Error(
      'Browser file actions cannot access hidden or sensitive paths.',
    );
  }
  return candidate;
}

function resolveBrowserInputFilePath(
  value: unknown,
  fileAccessRoot: string,
): string {
  const candidate = resolveBrowserPath(value, fileAccessRoot);
  const root = ensureBrowserArtifactRoot(fileAccessRoot);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Browser upload/drop paths must be regular files.');
  }
  assertInsideRoot(fs.realpathSync.native(candidate), root);
  return candidate;
}

function resolveBrowserOutputPath(
  value: unknown,
  fileAccessRoot: string,
): string {
  const candidate = resolveBrowserPath(value, fileAccessRoot);
  const root = ensureBrowserArtifactRoot(fileAccessRoot);
  const parent = path.dirname(candidate);
  fs.mkdirSync(parent, { recursive: true });
  assertNoSymlinkPath(parent, path.resolve(fileAccessRoot));
  assertInsideRoot(fs.realpathSync.native(parent), root);
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error('Browser file actions cannot write through symlinks.');
  }
  return candidate;
}

function assertInsideRoot(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      'Browser file actions are limited to the run browser artifact root.',
    );
  }
}

function assertNoSymlinkPath(target: string, root: string): void {
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Browser file actions cannot traverse symlinks.');
    }
  }
}

function isSensitivePathSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    lower.startsWith('.') ||
    lower === 'settings.yaml' ||
    lower === 'secrets' ||
    lower === 'credentials' ||
    lower === 'browser-profiles' ||
    lower === 'ipc'
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
