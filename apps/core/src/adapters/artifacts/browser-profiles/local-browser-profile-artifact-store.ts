import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ArtifactIntegrityError,
  type BrowserProfileArtifactFile,
  type BrowserProfileArtifactMaterializer,
  type BrowserProfileArtifactStore,
  type MaterializedBrowserProfileArtifact,
  type StoredBrowserProfileArtifact,
} from '../../../domain/ports/browser-profile-artifact-store.js';
import {
  browserProfileStorageRefFor,
  hashBrowserProfileFiles,
  normalizeBrowserProfileFiles,
  normalizeBrowserProfileStorageRef,
  resolveBrowserProfileAssetPath,
  resolveBrowserProfileSymlinkTarget,
} from './browser-profile-bundle.js';

/**
 * Filesystem-backed browser profile snapshot store. Mirrors the local toolchain
 * store: content-addressed `browser-profiles/<name>/<hash>/` prefixes with
 * sha256-verified atomic materialize and quarantine on mismatch. Used for the
 * workstation single-process deployment and as the injected store in tests;
 * fleet production uses the S3 variant.
 */
export class LocalBrowserProfileArtifactStore
  implements BrowserProfileArtifactStore, BrowserProfileArtifactMaterializer
{
  constructor(private readonly artifactRoot: string) {}

  async putBrowserProfile(input: {
    profileName: string;
    files: BrowserProfileArtifactFile[];
  }): Promise<StoredBrowserProfileArtifact> {
    const files = normalizeBrowserProfileFiles(input.files);
    const contentHash = hashBrowserProfileFiles(files);
    const storageRef = browserProfileStorageRefFor(
      input.profileName,
      contentHash,
    );
    const target = this.resolveStoragePath(storageRef);
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    let sizeBytes = 0;
    for (const file of files) {
      const filePath = resolveBrowserProfileAssetPath(target, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      if ((file.kind ?? 'file') === 'symlink') {
        await fs.symlink(
          resolveBrowserProfileSymlinkTarget(
            target,
            file.path,
            file.linkTarget ?? '',
          ),
          filePath,
        );
        continue;
      }
      const content = Buffer.from(file.content);
      await writeBrowserProfileFile(filePath, content, file.mode);
      sizeBytes += content.byteLength;
    }
    return {
      storageType: 'local-filesystem',
      storageRef,
      contentHash,
      sizeBytes,
    };
  }

  async materializeBrowserProfile(input: {
    storageRef: string;
    expectedContentHash: string;
    targetDir: string;
    quarantineDir: string;
  }): Promise<MaterializedBrowserProfileArtifact> {
    const source = this.resolveStoragePath(input.storageRef);
    const files = await readBrowserProfileFiles(source);
    const actualContentHash = hashBrowserProfileFiles(files);
    const targetDir = path.resolve(input.targetDir);
    await fs.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
    const tempDir = await fs.mkdtemp(
      path.join(path.dirname(targetDir), '.gantry-browser-profile-'),
    );
    try {
      let sizeBytes = 0;
      for (const file of files) {
        const filePath = resolveBrowserProfileAssetPath(tempDir, file.path);
        await fs.mkdir(path.dirname(filePath), {
          recursive: true,
          mode: 0o700,
        });
        if ((file.kind ?? 'file') === 'symlink') {
          await fs.symlink(
            resolveBrowserProfileSymlinkTarget(
              tempDir,
              file.path,
              file.linkTarget ?? '',
            ),
            filePath,
          );
          continue;
        }
        const content = Buffer.from(file.content);
        await writeBrowserProfileFile(filePath, content, file.mode);
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
    const normalizedRef = normalizeBrowserProfileStorageRef(storageRef);
    const rootPath = path.resolve(this.artifactRoot);
    const target = path.resolve(rootPath, ...normalizedRef.split('/'));
    if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error(`Invalid browser profile storage ref: ${storageRef}`);
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
  // Random suffix: concurrent integrity failures for the same storageRef must
  // never collapse onto one path and destroy a forensic copy.
  const stamp = `${storageRef.replace(/[^A-Za-z0-9._-]+/g, '-')}-${Date.now()}-${randomUUID()}`;
  const quarantinePath = path.join(root, stamp);
  await fs.rm(quarantinePath, { recursive: true, force: true });
  await fs.rename(sourceDir, quarantinePath);
  return quarantinePath;
}

async function writeBrowserProfileFile(
  filePath: string,
  content: Buffer,
  mode: number | undefined,
): Promise<void> {
  const fileMode = mode ?? 0o600;
  await fs.writeFile(filePath, content, { mode: fileMode });
  await fs.chmod(filePath, fileMode);
}

/**
 * Read a stored snapshot tree back into the file model. Unlike the snapshot
 * producer (which curates the exclude list while walking the live `user-data/`
 * dir), this reads a snapshot that is ALREADY curated, so no filtering happens
 * here — it must reproduce the exact bytes that were hashed at put time.
 */
async function readBrowserProfileFiles(
  root: string,
): Promise<BrowserProfileArtifactFile[]> {
  const rootPath = path.resolve(root);
  const files: BrowserProfileArtifactFile[] = [];

  async function recordSymlink(
    relative: string,
    entryPath: string,
  ): Promise<void> {
    const linkTarget = await fs.readlink(entryPath);
    resolveBrowserProfileSymlinkTarget(rootPath, relative, linkTarget);
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
