import path from 'node:path';

import type { BrowserProfileArtifactFile } from '../../../domain/ports/browser-profile-artifact-store.js';
import {
  hashBrowserProfileFileModel,
  normalizeBrowserProfileFileModel,
} from '../../../shared/browser-profile-hash.js';

/**
 * Browser profile snapshots are a flat, content-addressed file set. Normalize +
 * hash are shared with the runtime snapshot producer (so the cheap
 * "unchanged hash ⇒ skip put" pre-check matches the stored content hash byte for
 * byte), but the store normalizes paths through the traversal-guarding
 * {@link normalizeBrowserProfilePath} before hashing.
 */
export function normalizeBrowserProfileFiles(
  files: BrowserProfileArtifactFile[],
): BrowserProfileArtifactFile[] {
  return normalizeBrowserProfileFileModel(
    files.map((file) => ({
      ...file,
      path: normalizeBrowserProfilePath(file.path),
    })),
  );
}

export function hashBrowserProfileFiles(
  files: BrowserProfileArtifactFile[],
): string {
  return hashBrowserProfileFileModel(normalizeBrowserProfileFiles(files));
}

export function resolveBrowserProfileSymlinkTarget(
  root: string,
  linkPath: string,
  linkTarget: string,
): string {
  if (
    !linkTarget ||
    linkTarget.includes('\0') ||
    path.posix.isAbsolute(linkTarget) ||
    /^[A-Za-z]:\//.test(linkTarget)
  ) {
    throw new Error(`Invalid browser profile symlink target: ${linkTarget}`);
  }
  const rootPath = path.resolve(root);
  const linkAbsolutePath = resolveBrowserProfileAssetPath(rootPath, linkPath);
  const target = path.resolve(path.dirname(linkAbsolutePath), linkTarget);
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Invalid browser profile symlink target: ${linkTarget}`);
  }
  return linkTarget;
}

export function normalizeBrowserProfilePath(value: string): string {
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
    throw new Error(`Invalid browser profile path: ${value}`);
  }
  return parts.join('/');
}

export function normalizeBrowserProfileStorageRef(value: string): string {
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
    throw new Error(`Invalid browser profile storage ref: ${value}`);
  }
  return parts.join('/');
}

/** Content-addressed prefix: `browser-profiles/<profile>/<sha256-hex>`. */
export function browserProfileStorageRefFor(
  profileName: string,
  contentHash: string,
): string {
  const sanitized = profileName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  if (!sanitized) {
    throw new Error(`Invalid browser profile name: ${profileName}`);
  }
  const hash = /^sha256:([a-f0-9]{64})$/i.exec(contentHash)?.[1];
  if (!hash) {
    throw new Error(`Invalid browser profile content hash: ${contentHash}`);
  }
  return path.posix.join('browser-profiles', sanitized, hash.toLowerCase());
}

export function resolveBrowserProfileAssetPath(
  root: string,
  assetPath: string,
): string {
  const relative = normalizeBrowserProfilePath(assetPath);
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...relative.split('/'));
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Invalid browser profile path: ${assetPath}`);
  }
  return target;
}
