import fs from 'node:fs';
import path from 'node:path';

import type { BrowserIpcAction } from '@myclaw/contracts';

export function ensureBrowserArtifactRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

export function normalizeBrowserFilePayload(
  toolName: BrowserIpcAction,
  payload: Record<string, unknown>,
  options: { fileAccessRoot: string },
): Record<string, unknown> {
  const next = { ...payload };
  if (next.filename !== undefined) {
    next.filename = resolveBrowserOutputPath(
      next.filename,
      options.fileAccessRoot,
    );
  }
  if (toolName === 'browser_file_upload' && next.files !== undefined) {
    next.paths = [
      ...arrayValue(next.paths),
      ...materializeBrowserUploadFiles(next.files, options.fileAccessRoot),
    ];
    delete next.files;
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
  return value.map((item, index) =>
    materializeBrowserUploadFile(item, index, fileAccessRoot),
  );
}

function materializeBrowserUploadFile(
  value: unknown,
  index: number,
  fileAccessRoot: string,
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser upload/drop file entries must be objects.');
  }
  const row = value as Record<string, unknown>;
  const rawName = stringValue(row.name) || `upload-${index + 1}.txt`;
  const filename = path.join('uploads', rawName);
  const outputPath = resolveBrowserOutputPath(filename, fileAccessRoot);
  const content = row.content;
  if (typeof content !== 'string') {
    throw new Error('Browser upload/drop file content must be a string.');
  }
  const encoding = row.encoding === 'base64' ? 'base64' : 'utf8';
  fs.writeFileSync(outputPath, Buffer.from(content, encoding));
  return path.relative(ensureBrowserArtifactRoot(fileAccessRoot), outputPath);
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
