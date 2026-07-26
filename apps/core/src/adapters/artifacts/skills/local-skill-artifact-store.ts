import fs from 'node:fs';
import path from 'node:path';

import {
  type SkillArtifactAsset,
  type SkillArtifactBundle,
  type SkillArtifactStore,
  type StoredSkillArtifact,
} from '../../../domain/ports/skill-artifact-store.js';
import {
  hashSkillBundle,
  normalizeSkillBundle,
} from '../../../shared/skill-artifact-helpers.js';

export class LocalSkillArtifactStore implements SkillArtifactStore {
  constructor(private readonly artifactRoot: string) {}

  async putSkillArtifact(input: {
    appId: string;
    skillId: string;
    skillName: string;
    bundle: SkillArtifactBundle;
  }): Promise<StoredSkillArtifact> {
    const bundle = normalizeSkillBundle(input.bundle);
    // ponytail: content-hash uniqueness relies on hashSkillBundle framing; a crafted NUL-framing collision only risks same-(app,skill) stale bytes, not cross-app isolation (appId/catalogId provide that); framing hardening deferred as D-0011.
    const contentHash = hashSkillBundle(bundle);
    const storageRef = path.posix.join(
      'apps',
      encodeStorageSegment(input.appId),
      'skills',
      encodeStorageSegment(input.skillId),
      encodeStorageSegment(contentHash),
    );
    const target = resolveStoragePath(this.artifactRoot, storageRef);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    let sizeBytes = 0;
    for (const asset of bundle.assets) {
      const filePath = resolveAssetPath(target, asset.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const content = Buffer.from(asset.content);
      fs.writeFileSync(filePath, content, { mode: 0o600 });
      sizeBytes += content.byteLength;
    }
    // ponytail: Superseded hash directories stay in place; garbage collection is a follow-up.
    return {
      storageType: 'local-filesystem',
      storageRef,
      contentHash,
      sizeBytes,
    };
  }

  async getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle> {
    const target = resolveStoragePath(this.artifactRoot, storageRef);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Skill artifact storage ref is not a directory: ${storageRef}`,
      );
    }
    return normalizeSkillBundle({ assets: readAssetsRecursive(target) });
  }
}

function normalizeAssetPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    path.posix.isAbsolute(normalized) ||
    parts.some(
      (part) =>
        part === '..' ||
        part === '.' ||
        part === '' ||
        isHiddenPathSegment(part),
    )
  ) {
    throw new Error(`Invalid skill artifact path: ${value}`);
  }
  return parts.join('/');
}

function resolveStoragePath(root: string, storageRef: string): string {
  const normalizedRef = normalizeStorageRef(storageRef);
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...normalizedRef.split('/'));
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Invalid skill artifact storage ref: ${storageRef}`);
  }
  return target;
}

function normalizeStorageRef(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    path.posix.isAbsolute(normalized) ||
    parts.some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error(`Invalid skill artifact storage ref: ${value}`);
  }
  return parts.join('/');
}

function resolveAssetPath(root: string, assetPath: string): string {
  const relative = normalizeAssetPath(assetPath);
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...relative.split('/'));
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Invalid skill artifact path: ${assetPath}`);
  }
  return target;
}

function readAssetsRecursive(root: string): SkillArtifactAsset[] {
  const rootPath = path.resolve(root);
  const assets: SkillArtifactAsset[] = [];

  function visit(directory: string): void {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (isHiddenPathSegment(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      const relative = path
        .relative(rootPath, entryPath)
        .split(path.sep)
        .join('/');
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill artifact cannot contain symlinks: ${relative}`);
      }
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const assetPath = normalizeAssetPath(relative);
      assets.push({
        path: assetPath,
        contentType: contentTypeForPath(assetPath),
        content: fs.readFileSync(entryPath),
      });
    }
  }

  visit(rootPath);
  return assets;
}

function contentTypeForPath(assetPath: string): string | undefined {
  if (assetPath.endsWith('.md')) return 'text/markdown';
  if (assetPath.endsWith('.json')) return 'application/json';
  if (assetPath.endsWith('.txt')) return 'text/plain';
  return undefined;
}

function isHiddenPathSegment(value: string): boolean {
  return value.startsWith('.');
}

function encodeStorageSegment(value: string): string {
  const encoded = encodeURIComponent(value).replace(/\./g, '%2E');
  if (!encoded) throw new Error('Skill artifact storage segment is empty');
  return encoded;
}
