import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import {
  ArtifactIntegrityError,
  type MaterializedSkillArtifact,
  type SkillArtifactBundle,
  type SkillArtifactMaterializer,
  type SkillArtifactStore,
  type StoredSkillArtifact,
} from '../../../domain/ports/skill-artifact-store.js';
import { materializedSkillDirectoryNameFor } from '../../../domain/skills/skills.js';
import {
  hashSkillBundle,
  normalizeSkillBundle,
} from './local-skill-artifact-store.js';

/**
 * Object whose final key segment starts with this marker is artifact metadata,
 * not a skill asset; it mirrors the local store's hidden-segment handling so
 * the rebuilt bundle excludes it.
 */
const ARTIFACT_MANIFEST_KEY = '.gantry-artifact.json';
const S3_DELETE_OBJECTS_MAX_KEYS = 1000;

interface ArtifactManifest {
  contentHash: string;
  sizeBytes: number;
  assetPaths: string[];
}

/**
 * Current-state S3 artifact store. Mirrors the local skill store layout: a
 * skill maps to the key prefix `skills/<sanitized-name>/` with one object per
 * asset. Updates replace the prefix in place (no versioning). Integrity reuses
 * the shared `hashSkillBundle` content hash; materialize verifies sha256 and
 * atomically activates, quarantining on mismatch.
 */
export class S3SkillArtifactStore
  implements SkillArtifactStore, SkillArtifactMaterializer
{
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

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
    // Replace-on-update: clear the prefix before writing the new asset set.
    await this.deletePrefix(storageRef);
    let sizeBytes = 0;
    const assetPaths: string[] = [];
    for (const asset of bundle.assets) {
      const relative = normalizeAssetPath(asset.path);
      const content = Buffer.from(asset.content);
      const key = objectKey(storageRef, relative);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: content,
          ContentType: asset.contentType,
          Metadata: { sha256: sha256Hex(content) },
        }),
      );
      sizeBytes += content.byteLength;
      assetPaths.push(relative);
    }
    const manifest: ArtifactManifest = {
      contentHash,
      sizeBytes,
      assetPaths: [...assetPaths].sort((a, b) => a.localeCompare(b)),
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf-8');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey(storageRef, ARTIFACT_MANIFEST_KEY),
        Body: manifestBody,
        ContentType: 'application/json',
        Metadata: { sha256: contentHash.replace(/^sha256:/, '') },
      }),
    );
    return {
      storageType: 'object-store',
      storageRef,
      contentHash,
      sizeBytes,
    };
  }

  async getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle> {
    const prefix = `${normalizeStorageRef(storageRef)}/`;
    const objects = await this.listPrefix(prefix);
    const assets: SkillArtifactBundle['assets'] = [];
    for (const key of objects) {
      const relative = key.slice(prefix.length);
      if (isHiddenPathSegment(relative)) continue;
      const content = await this.getObjectBytes(key);
      assets.push({
        path: normalizeAssetPath(relative),
        contentType: contentTypeForPath(relative),
        content: new Uint8Array(content),
      });
    }
    return normalizeSkillBundle({ assets });
  }

  async materializeSkillArtifact(input: {
    storageRef: string;
    expectedContentHash: string;
    targetDir: string;
    quarantineDir: string;
  }): Promise<MaterializedSkillArtifact> {
    const bundle = await this.getSkillArtifact(input.storageRef);
    const actualContentHash = hashSkillBundle(bundle);
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gantry-artifact-'),
    );
    try {
      let sizeBytes = 0;
      for (const asset of bundle.assets) {
        const filePath = resolveAssetPath(tempDir, asset.path);
        await fs.mkdir(path.dirname(filePath), {
          recursive: true,
          mode: 0o700,
        });
        const content = Buffer.from(asset.content);
        await fs.writeFile(filePath, content, { mode: 0o600 });
        sizeBytes += content.byteLength;
      }
      if (actualContentHash !== input.expectedContentHash) {
        const quarantinePath = await this.quarantine(
          tempDir,
          input.quarantineDir,
          input.storageRef,
        );
        throw new ArtifactIntegrityError({
          storageRef: input.storageRef,
          expectedContentHash: input.expectedContentHash,
          actualContentHash,
          quarantinePath,
        });
      }
      const targetDir = path.resolve(input.targetDir);
      await fs.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.rename(tempDir, targetDir);
      return {
        storageRef: input.storageRef,
        contentHash: actualContentHash,
        targetDir,
        sizeBytes,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async quarantine(
    sourceDir: string,
    quarantineRoot: string,
    storageRef: string,
  ): Promise<string> {
    const root = path.resolve(quarantineRoot);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    // Random suffix: concurrent integrity failures for the same storageRef
    // must never collapse onto one path and destroy a forensic copy.
    const stamp = `${sanitizeSegment(storageRef)}-${Date.now()}-${randomUUID()}`;
    const quarantinePath = path.join(root, stamp);
    await fs.rm(quarantinePath, { recursive: true, force: true });
    await fs.rename(sourceDir, quarantinePath);
    return quarantinePath;
  }

  private async deletePrefix(storageRef: string): Promise<void> {
    const prefix = `${normalizeStorageRef(storageRef)}/`;
    const keys = await this.listPrefix(prefix);
    if (keys.length === 0) return;
    for (
      let start = 0;
      start < keys.length;
      start += S3_DELETE_OBJECTS_MAX_KEYS
    ) {
      const chunk = keys.slice(start, start + S3_DELETE_OBJECTS_MAX_KEYS);
      const response = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
      if (response.Errors && response.Errors.length > 0) {
        throw new Error(
          `Failed to delete ${response.Errors.length} S3 skill artifact object(s) under ${storageRef}`,
        );
      }
    }
  }

  private async listPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const entry of response.Contents ?? []) {
        if (entry.Key) keys.push(entry.Key);
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  }

  private async getObjectBytes(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body;
    if (!body || typeof body.transformToByteArray !== 'function') {
      throw new Error(`S3 object ${key} returned no readable body`);
    }
    return Buffer.from(await body.transformToByteArray());
  }
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function objectKey(storageRef: string, relative: string): string {
  return `${normalizeStorageRef(storageRef)}/${relative}`;
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

function contentTypeForPath(assetPath: string): string | undefined {
  if (assetPath.endsWith('.md')) return 'text/markdown';
  if (assetPath.endsWith('.json')) return 'application/json';
  if (assetPath.endsWith('.txt')) return 'text/plain';
  return undefined;
}

function isHiddenPathSegment(value: string): boolean {
  return value.split('/').some((part) => part.startsWith('.'));
}

function sanitizeSegment(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return safe || 'skill';
}
