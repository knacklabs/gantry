import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  FileArtifactNotFoundError,
  type FileArtifactId,
} from '../../../domain/file-artifacts/file-artifact.js';

export interface StoredFileArtifactBytes {
  storageRef: string;
  contentHash: string;
  sizeBytes: number;
}

function bytesFor(content: Uint8Array | string): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf-8')
    : Buffer.from(content);
}

export function hashFileArtifactBytes(content: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytesFor(content)).digest('hex')}`;
}

export class LocalFileArtifactBytes {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async putBytes(input: {
    id: FileArtifactId;
    appId: string;
    agentId: string;
    virtualScope: string;
    virtualPath: string;
    version: number;
    content: Uint8Array | string;
  }): Promise<StoredFileArtifactBytes> {
    const content = bytesFor(input.content);
    const contentHash = hashFileArtifactBytes(content);
    const storageRef = [
      `app_${sanitizeSegment(input.appId)}`,
      `agent_${sanitizeSegment(input.agentId)}`,
      `scope_${sanitizeSegment(input.virtualScope)}`,
      ...input.virtualPath.split('/').map(sanitizeSegment),
      `v${input.version}_${sanitizeSegment(input.id)}`,
    ].join('/');
    const filePath = this.resolve(storageRef);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.tmp`,
    );
    await fs.writeFile(tmpPath, content, { mode: 0o600 });
    await fs.rename(tmpPath, filePath);
    return { storageRef, contentHash, sizeBytes: content.byteLength };
  }

  async getBytes(
    storageRef: string,
    expected: { hash: string; sizeBytes: number },
  ): Promise<Buffer> {
    let content: Buffer;
    try {
      content = await fs.readFile(this.resolve(storageRef));
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === 'ENOENT') {
        throw new FileArtifactNotFoundError();
      }
      throw err;
    }
    const actualHash = hashFileArtifactBytes(content);
    if (actualHash !== expected.hash) {
      throw new Error(
        `File artifact hash mismatch: expected ${expected.hash}, got ${actualHash}`,
      );
    }
    if (content.byteLength !== expected.sizeBytes) {
      throw new Error(
        `File artifact size mismatch: expected ${expected.sizeBytes}, got ${content.byteLength}`,
      );
    }
    return content;
  }

  async removeBytes(storageRef: string): Promise<void> {
    await fs.rm(this.resolve(storageRef), { force: true });
  }

  async healthCheck(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.access(this.root, constants.R_OK | constants.W_OK);
  }

  private resolve(storageRef: string): string {
    const normalized = normalizeStorageRef(storageRef);
    const target = path.resolve(this.root, ...normalized.split('/'));
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Invalid file artifact storage ref: ${storageRef}`);
    }
    return target;
  }
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function normalizeStorageRef(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    parts.some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error(`Invalid file artifact storage ref: ${value}`);
  }
  return parts.join('/');
}

function sanitizeSegment(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160);
  return safe || 'unknown';
}
