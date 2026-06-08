import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  SkillArtifactAsset,
  SkillArtifactBundle,
  SkillArtifactStore,
  StoredSkillArtifact,
} from '../../../domain/ports/skill-artifact-store.js';
import { materializedSkillDirectoryNameFor } from '../../../domain/skills/skills.js';

export class LocalSkillArtifactStore implements SkillArtifactStore {
  constructor(private readonly artifactRoot: string) {}

  async putSkillArtifact(input: {
    appId: string;
    skillId: string;
    skillName: string;
    bundle: SkillArtifactBundle;
  }): Promise<StoredSkillArtifact> {
    const bundle = normalizeSkillBundle(input.bundle);
    const contentHash = hashSkillBundle(bundle);
    const storageRef = path.posix.join(
      'skills',
      sanitizeSegment(materializedSkillDirectoryNameFor(input.skillName)),
    );
    const target = resolveStoragePath(this.artifactRoot, storageRef);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    let sizeBytes = 0;
    for (const asset of bundle.assets) {
      const filePath = resolveAssetPath(target, asset.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const content = Buffer.from(asset.content);
      fs.writeFileSync(filePath, content, { mode: 0o600 });
      sizeBytes += content.byteLength;
    }
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

export function normalizeSkillBundle(
  bundle: SkillArtifactBundle,
): SkillArtifactBundle {
  const assets = bundle.assets
    .map((asset) => ({
      path: normalizeAssetPath(asset.path),
      contentType: asset.contentType,
      content: new Uint8Array(asset.content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!assets.some((asset) => asset.path === 'SKILL.md')) {
    throw new Error('Skill artifact must contain SKILL.md');
  }
  return { assets };
}

export function hashSkillBundle(bundle: SkillArtifactBundle): string {
  const hash = createHash('sha256');
  for (const asset of normalizeSkillBundle(bundle).assets) {
    hash.update(asset.path);
    hash.update('\0');
    hash.update(asset.content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
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

function sanitizeSegment(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return safe || 'skill';
}
