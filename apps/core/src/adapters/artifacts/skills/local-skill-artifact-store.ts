import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  SkillArtifactBundle,
  SkillArtifactStore,
  StoredSkillArtifact,
} from '../../../domain/ports/skill-artifact-store.js';

type SerializedSkillAsset = {
  path: string;
  contentType?: string;
  contentBase64: string;
};

type SerializedSkillBundle = {
  assets: SerializedSkillAsset[];
};

export class LocalSkillArtifactStore implements SkillArtifactStore {
  constructor(private readonly artifactRoot: string) {}

  async putSkillArtifact(input: {
    appId: string;
    skillId: string;
    bundle: SkillArtifactBundle;
  }): Promise<StoredSkillArtifact> {
    const bundle = normalizeSkillBundle(input.bundle);
    const contentHash = hashSkillBundle(bundle);
    const serialized = serializeBundle(bundle);
    const bytes = Buffer.from(JSON.stringify(serialized, null, 2), 'utf-8');
    const storageRef = path.join(
      'skills',
      sanitizeSegment(input.appId),
      sanitizeSegment(input.skillId),
      `${contentHash.replace(/^sha256:/, '')}.json`,
    );
    const target = resolveStoragePath(this.artifactRoot, storageRef);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    return {
      storageType: 'local-filesystem',
      storageRef,
      contentHash,
      sizeBytes: bytes.byteLength,
    };
  }

  async getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle> {
    const target = resolveStoragePath(this.artifactRoot, storageRef);
    const raw = fs.readFileSync(target, 'utf-8');
    const parsed = JSON.parse(raw) as SerializedSkillBundle;
    return normalizeSkillBundle({
      assets: parsed.assets.map((asset) => ({
        path: asset.path,
        contentType: asset.contentType,
        content: Buffer.from(asset.contentBase64, 'base64'),
      })),
    });
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

function serializeBundle(bundle: SkillArtifactBundle): SerializedSkillBundle {
  return {
    assets: normalizeSkillBundle(bundle).assets.map((asset) => ({
      path: asset.path,
      contentType: asset.contentType,
      contentBase64: Buffer.from(asset.content).toString('base64'),
    })),
  };
}

function normalizeAssetPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (
    !normalized ||
    normalized.includes('\0') ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Invalid skill artifact path: ${value}`);
  }
  return normalized;
}

function resolveStoragePath(root: string, storageRef: string): string {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, storageRef);
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Invalid skill artifact storage ref: ${storageRef}`);
  }
  return target;
}

function sanitizeSegment(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
  return safe || 'skill';
}
