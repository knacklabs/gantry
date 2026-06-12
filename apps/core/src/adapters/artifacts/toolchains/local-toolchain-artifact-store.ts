import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

/**
 * Filesystem-backed toolchain artifact store. Mirrors the local skill store:
 * replace-on-update under the content-addressed `toolchains/<hash>/` prefix,
 * sha256-verified atomic materialize with quarantine on mismatch. Used for the
 * disposable-Postgres integration rehearsal and as the injected fake-free store
 * in tests; fleet production uses the S3 variant.
 */
export class LocalToolchainArtifactStore
  implements ToolchainArtifactStore, ToolchainArtifactMaterializer
{
  constructor(private readonly artifactRoot: string) {}

  async putToolchainArtifact(input: {
    appId: string;
    manifestHash: string;
    files: ToolchainArtifactFile[];
  }): Promise<StoredToolchainArtifact> {
    const files = normalizeToolchainFiles(input.files);
    const contentHash = hashToolchainFiles(files);
    const storageRef = toolchainStorageRefFor(input.manifestHash);
    const target = this.resolveStoragePath(storageRef);
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    let sizeBytes = 0;
    for (const file of files) {
      const filePath = resolveToolchainAssetPath(target, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      if ((file.kind ?? 'file') === 'symlink') {
        await fs.symlink(
          resolveToolchainSymlinkTarget(
            target,
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
    return {
      storageType: 'local-filesystem',
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
    const source = this.resolveStoragePath(input.storageRef);
    const files = await readToolchainFiles(source);
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
        const quarantinePath = await quarantine(
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

  private resolveStoragePath(storageRef: string): string {
    const normalizedRef = normalizeToolchainStorageRef(storageRef);
    const rootPath = path.resolve(this.artifactRoot);
    const target = path.resolve(rootPath, ...normalizedRef.split('/'));
    if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error(`Invalid toolchain artifact storage ref: ${storageRef}`);
    }
    return target;
  }
}

async function quarantine(
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

async function writeToolchainFile(
  filePath: string,
  content: Buffer,
  mode: number | undefined,
): Promise<void> {
  const fileMode = mode ?? 0o600;
  await fs.writeFile(filePath, content, { mode: fileMode });
  await fs.chmod(filePath, fileMode);
}

async function readToolchainFiles(
  root: string,
): Promise<ToolchainArtifactFile[]> {
  const rootPath = path.resolve(root);
  const files: ToolchainArtifactFile[] = [];

  async function recordSymlink(
    relative: string,
    entryPath: string,
  ): Promise<void> {
    const linkTarget = await fs.readlink(entryPath);
    resolveToolchainSymlinkTarget(rootPath, relative, linkTarget);
    files.push({
      path: relative,
      kind: 'symlink',
      linkTarget,
      content: Buffer.alloc(0),
    });
  }

  async function visitWithSymlinks(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name);
      const relative = path
        .relative(rootPath, entryPath)
        .split(path.sep)
        .join('/');
      if (entry.isSymbolicLink()) {
        await recordSymlink(relative, entryPath);
        continue;
      }
      if (entry.isDirectory()) {
        await visitWithSymlinks(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(entryPath);
      files.push({
        path: relative,
        kind: 'file',
        mode: stat.mode & 0o777,
        content: await fs.readFile(entryPath),
      });
    }
  }

  await visitWithSymlinks(rootPath);
  return files;
}
