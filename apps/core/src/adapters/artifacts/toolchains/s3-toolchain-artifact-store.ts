import { randomUUID } from 'node:crypto';
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
  type MaterializedToolchainArtifact,
  type StoredToolchainArtifact,
  type ToolchainArtifactFile,
  type ToolchainArtifactMaterializer,
  type ToolchainArtifactStore,
} from '../../../domain/ports/toolchain-artifact-store.js';
import {
  hashToolchainFiles,
  normalizeToolchainFiles,
  normalizeToolchainStorageRef,
  resolveToolchainAssetPath,
  resolveToolchainSymlinkTarget,
  toolchainStorageRefFor,
} from './toolchain-artifact-bundle.js';

const S3_DELETE_OBJECTS_MAX_KEYS = 1000;

/**
 * Current-state S3 toolchain artifact store for fleet mode. Objects live under
 * the content-addressed `toolchains/<manifestHash>/<relpath>` prefix and are
 * replaced in place on update (no versioning). Materialize lists the prefix,
 * verifies sha256 against the recorded hash, and atomically activates,
 * quarantining on mismatch. Bake role holds rw; workers hold ro (split IAM).
 */
export class S3ToolchainArtifactStore
  implements ToolchainArtifactStore, ToolchainArtifactMaterializer
{
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putToolchainArtifact(input: {
    appId: string;
    manifestHash: string;
    files: ToolchainArtifactFile[];
  }): Promise<StoredToolchainArtifact> {
    const files = normalizeToolchainFiles(input.files);
    const contentHash = hashToolchainFiles(files);
    const storageRef = toolchainStorageRefFor(input.manifestHash);
    await this.deletePrefix(storageRef);
    let sizeBytes = 0;
    for (const file of files) {
      const content = Buffer.from(file.content);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey(storageRef, file.path),
          Body: content,
          Metadata: objectMetadata(file),
        }),
      );
      sizeBytes += content.byteLength;
    }
    return {
      storageType: 'object-store',
      storageRef,
      contentHash,
      sizeBytes,
    };
  }

  async materializeToolchainArtifact(input: {
    storageRef: string;
    expectedContentHash: string;
    targetDir: string;
    quarantineDir: string;
  }): Promise<MaterializedToolchainArtifact> {
    const files = await this.fetchToolchainFiles(input.storageRef);
    const actualContentHash = hashToolchainFiles(files);
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gantry-toolchain-'),
    );
    try {
      let sizeBytes = 0;
      for (const file of files) {
        const filePath = resolveToolchainAssetPath(tempDir, file.path);
        await fs.mkdir(path.dirname(filePath), {
          recursive: true,
          mode: 0o700,
        });
        if ((file.kind ?? 'file') === 'symlink') {
          await fs.symlink(
            resolveToolchainSymlinkTarget(
              tempDir,
              file.path,
              file.linkTarget ?? '',
            ),
            filePath,
          );
          continue;
        }
        const content = Buffer.from(file.content);
        await writeToolchainFile(filePath, content, file.mode);
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

  private async fetchToolchainFiles(
    storageRef: string,
  ): Promise<ToolchainArtifactFile[]> {
    const prefix = `${normalizeToolchainStorageRef(storageRef)}/`;
    const keys = await this.listPrefix(prefix);
    const files: ToolchainArtifactFile[] = [];
    for (const key of keys) {
      const relative = key.slice(prefix.length);
      if (!relative) continue;
      const object = await this.getObject(key);
      files.push({
        path: relative,
        kind: object.kind,
        mode: object.mode,
        linkTarget: object.linkTarget,
        content: new Uint8Array(object.content),
      });
    }
    return files;
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
    const stamp = `${storageRef.replace(/[^A-Za-z0-9._-]+/g, '-')}-${Date.now()}-${randomUUID()}`;
    const quarantinePath = path.join(root, stamp);
    await fs.rm(quarantinePath, { recursive: true, force: true });
    await fs.rename(sourceDir, quarantinePath);
    return quarantinePath;
  }

  private async deletePrefix(storageRef: string): Promise<void> {
    const prefix = `${normalizeToolchainStorageRef(storageRef)}/`;
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
          `Failed to delete ${response.Errors.length} S3 toolchain artifact object(s) under ${storageRef}`,
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

  private async getObject(key: string): Promise<{
    content: Buffer;
    kind: 'file' | 'symlink';
    mode?: number;
    linkTarget?: string;
  }> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body;
    if (!body || typeof body.transformToByteArray !== 'function') {
      throw new Error(`S3 object ${key} returned no readable body`);
    }
    const metadata = response.Metadata ?? {};
    const kind = metadata['gantry-kind'] === 'symlink' ? 'symlink' : 'file';
    const mode = metadata['gantry-mode']
      ? Number.parseInt(metadata['gantry-mode'], 8)
      : undefined;
    return {
      content: Buffer.from(await body.transformToByteArray()),
      kind,
      mode: Number.isFinite(mode) ? mode : undefined,
      linkTarget: decodeLinkTarget(metadata),
    };
  }
}

async function writeToolchainFile(
  filePath: string,
  content: Buffer,
  mode: number | undefined,
): Promise<void> {
  const fileMode = mode ?? 0o600;
  await fs.writeFile(filePath, content, { mode: fileMode });
  await fs.chmod(filePath, fileMode);
}

function objectKey(storageRef: string, relative: string): string {
  return `${normalizeToolchainStorageRef(storageRef)}/${relative}`;
}

function objectMetadata(file: ToolchainArtifactFile): Record<string, string> {
  const metadata: Record<string, string> = {
    'gantry-kind': file.kind ?? 'file',
  };
  if (file.mode !== undefined) {
    metadata['gantry-mode'] = file.mode.toString(8);
  }
  if (file.linkTarget !== undefined) {
    metadata['gantry-link-target-b64'] = Buffer.from(
      file.linkTarget,
      'utf8',
    ).toString('base64');
  }
  return metadata;
}

function decodeLinkTarget(
  metadata: Record<string, string>,
): string | undefined {
  const encoded = metadata['gantry-link-target-b64'];
  if (encoded) {
    return Buffer.from(encoded, 'base64').toString('utf8');
  }
  return metadata['gantry-link-target'];
}
