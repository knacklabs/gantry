import type { ToolchainArtifactFile } from '../../../domain/ports/toolchain-artifact-store.js';
/**
 * Toolchain artifacts are a flat, content-addressed file set (node_modules +
 * lockfile + package.json). Unlike skill bundles they carry no required marker
 * file (no SKILL.md), so they get their own normalize/hash here rather than
 * reusing the skill bundle helpers, while keeping the identical
 * `sha256(path \0 content \0 ...)` content-hash shape so a worker can verify a
 * fetched artifact against the recorded hash.
 */
export declare function normalizeToolchainFiles(files: ToolchainArtifactFile[]): ToolchainArtifactFile[];
export declare function hashToolchainFiles(files: ToolchainArtifactFile[]): string;
export declare function resolveToolchainSymlinkTarget(root: string, linkPath: string, linkTarget: string): string;
export declare function normalizeToolchainPath(value: string): string;
export declare function normalizeToolchainStorageRef(value: string): string;
/** Content-addressed prefix for a manifest: `toolchains/<sanitized-hash>`. */
export declare function toolchainStorageRefFor(manifestHash: string): string;
export declare function resolveToolchainAssetPath(root: string, assetPath: string): string;
