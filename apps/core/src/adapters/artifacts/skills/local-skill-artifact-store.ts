import { randomBytes } from 'node:crypto';
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
    // The content hash is both the immutable storage key and integrity value;
    // hashSkillBundle uses unambiguous length-prefixed framing.
    const contentHash = hashSkillBundle(bundle);
    const storageRef = path.posix.join(
      'apps',
      encodeStorageSegment(input.appId),
      'skills',
      encodeStorageSegment(input.skillId),
      encodeStorageSegment(contentHash),
    );
    const target = resolveStoragePath(this.artifactRoot, storageRef);
    const sizeBytes = bundle.assets.reduce(
      (total, asset) => total + asset.content.byteLength,
      0,
    );
    const stored: StoredSkillArtifact = {
      storageType: 'local-filesystem',
      storageRef,
      contentHash,
      sizeBytes,
    };
    if (fs.existsSync(target)) {
      return stored;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tempDir = `${target}.tmp-${randomBytes(16).toString('hex')}`;
    fs.mkdirSync(tempDir, { mode: 0o700 });
    try {
      for (const asset of bundle.assets) {
        const filePath = resolveAssetPath(tempDir, asset.path);
        fs.mkdirSync(path.dirname(filePath), {
          recursive: true,
          mode: 0o700,
        });
        fs.writeFileSync(filePath, Buffer.from(asset.content), { mode: 0o600 });
      }
      try {
        fs.renameSync(tempDir, target);
      } catch (error) {
        if (!isConcurrentPublish(error) || !fs.existsSync(target)) {
          throw error;
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    // ponytail: Superseded hash directories stay in place; garbage collection is a follow-up.
    return stored;
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

function isConcurrentPublish(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}
