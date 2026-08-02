import type { BrowserProfileArtifactFile } from '../../../domain/ports/browser-profile-artifact-store.js';
/**
 * Browser profile snapshots are a flat, content-addressed file set. Normalize +
 * hash are shared with the runtime snapshot producer (so the cheap
 * "unchanged hash ⇒ skip put" pre-check matches the stored content hash byte for
 * byte), but the store normalizes paths through the traversal-guarding
 * {@link normalizeBrowserProfilePath} before hashing.
 */
export declare function normalizeBrowserProfileFiles(files: BrowserProfileArtifactFile[]): BrowserProfileArtifactFile[];
export declare function hashBrowserProfileFiles(files: BrowserProfileArtifactFile[]): string;
export declare function resolveBrowserProfileSymlinkTarget(root: string, linkPath: string, linkTarget: string): string;
export declare function normalizeBrowserProfilePath(value: string): string;
export declare function normalizeBrowserProfileStorageRef(value: string): string;
/** Content-addressed prefix: `browser-profiles/<profile>/<sha256-hex>`. */
export declare function browserProfileStorageRefFor(profileName: string, contentHash: string): string;
export declare function resolveBrowserProfileAssetPath(root: string, assetPath: string): string;
