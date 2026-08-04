/**
 * Packages explicitly allowed to run install scripts during a bake. Bakes run
 * `npm install --ignore-scripts` by default (ADR capability-artifacts); only
 * packages on this code-reviewed allowlist may re-enable scripts because they
 * genuinely need a native build step. Empty by default — adding an entry is a
 * reviewed code change, never runtime input.
 */
export declare const NATIVE_MODULE_SCRIPT_ALLOWLIST: readonly string[];
/** Error message ADR-2 mandates for non-npm/system-package requests. */
export declare const SYSTEM_PACKAGE_ERROR = "system packages require an image bake";
export interface ToolchainManifest {
    /** Sorted, validated npm package specs (e.g. ["left-pad@1.3.0"]). */
    packages: string[];
    /** Allowlisted npm registry the bake pins via .npmrc. */
    registry: string;
}
export interface NormalizedToolchainManifest extends ToolchainManifest {
    manifestHash: string;
    /** Subset of `packages` whose names are on the native-module allowlist. */
    scriptAllowedPackages: string[];
}
export declare function isValidNpmSpec(spec: string): boolean;
export declare function npmPackageName(spec: string): string;
/**
 * Validate and normalize a requested npm manifest. Throws with the ADR-2 system
 * package error when any spec is not a plain npm spec. The manifest hash is the
 * bake idempotency key: identical (sorted) package sets and registry produce
 * the same hash regardless of request order.
 */
export declare function normalizeToolchainManifest(input: ToolchainManifest): NormalizedToolchainManifest;
export declare function hashToolchainManifest(packages: string[], registry: string): string;
/** Minimal package.json the bake writes before running `npm install`. */
export declare function renderBakePackageJson(packages: string[]): string;
/** `.npmrc` pinning the allowlisted registry; audit/fund off for clean output. */
export declare function renderBakeNpmrc(registry: string): string;
