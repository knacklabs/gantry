import { createHash } from 'node:crypto';

/**
 * Packages explicitly allowed to run install scripts during a bake. Bakes run
 * `npm install --ignore-scripts` by default (ADR capability-artifacts); only
 * packages on this code-reviewed allowlist may re-enable scripts because they
 * genuinely need a native build step. Empty by default — adding an entry is a
 * reviewed code change, never runtime input.
 */
export const NATIVE_MODULE_SCRIPT_ALLOWLIST: readonly string[] = [];

/** Error message ADR-2 mandates for non-npm/system-package requests. */
export const SYSTEM_PACKAGE_ERROR = 'system packages require an image bake';

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

// npm spec: optional @scope, name, optional @version-range. Rejects shell
// metacharacters, paths, urls, and git/file specs so the manifest is npm-only.
const NPM_NAME = '(?:@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*';
const NPM_SPEC_PATTERN = new RegExp(
  `^${NPM_NAME}(?:@[A-Za-z0-9-._~^>=<|* ]+)?$`,
);

export function isValidNpmSpec(spec: string): boolean {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.length > 214) return false;
  if (/[\s]/.test(trimmed.replace(/@[^@]*$/, ''))) return false;
  if (
    trimmed.includes('://') ||
    trimmed.startsWith('git+') ||
    trimmed.startsWith('file:') ||
    trimmed.includes('..')
  ) {
    return false;
  }
  return NPM_SPEC_PATTERN.test(trimmed);
}

export function npmPackageName(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith('@')) {
    const slash = trimmed.indexOf('/');
    if (slash === -1) return trimmed;
    const rest = trimmed.slice(slash + 1);
    const at = rest.indexOf('@');
    return `${trimmed.slice(0, slash + 1)}${at === -1 ? rest : rest.slice(0, at)}`;
  }
  const at = trimmed.indexOf('@');
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

/**
 * Validate and normalize a requested npm manifest. Throws with the ADR-2 system
 * package error when any spec is not a plain npm spec. The manifest hash is the
 * bake idempotency key: identical (sorted) package sets and registry produce
 * the same hash regardless of request order.
 */
export function normalizeToolchainManifest(
  input: ToolchainManifest,
): NormalizedToolchainManifest {
  const packages = [...new Set(input.packages.map((spec) => spec.trim()))]
    .filter((spec) => spec.length > 0)
    .sort();
  if (packages.length === 0) {
    throw new Error('Toolchain bake requires at least one npm package.');
  }
  for (const spec of packages) {
    if (!isValidNpmSpec(spec)) {
      throw new Error(
        `${SYSTEM_PACKAGE_ERROR}: "${spec}" is not a valid npm package spec.`,
      );
    }
  }
  const registry = input.registry.trim();
  if (!/^https?:\/\//.test(registry)) {
    throw new Error('Toolchain bake registry must be an http(s) URL.');
  }
  const allowlist = new Set(NATIVE_MODULE_SCRIPT_ALLOWLIST);
  const scriptAllowedPackages = packages
    .map(npmPackageName)
    .filter((name) => allowlist.has(name))
    .sort();
  const manifestHash = hashToolchainManifest(packages, registry);
  return { packages, registry, manifestHash, scriptAllowedPackages };
}

export function hashToolchainManifest(
  packages: string[],
  registry: string,
): string {
  const hash = createHash('sha256');
  hash.update('npm');
  hash.update('\0');
  hash.update(registry);
  hash.update('\0');
  for (const spec of [...packages].sort()) {
    hash.update(spec);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Minimal package.json the bake writes before running `npm install`. */
export function renderBakePackageJson(packages: string[]): string {
  const dependencies: Record<string, string> = {};
  for (const spec of packages) {
    const name = npmPackageName(spec);
    const version = spec.slice(name.length).replace(/^@/, '') || '*';
    dependencies[name] = version;
  }
  return `${JSON.stringify(
    { name: 'gantry-toolchain', private: true, dependencies },
    null,
    2,
  )}\n`;
}

/** `.npmrc` pinning the allowlisted registry; audit/fund off for clean output. */
export function renderBakeNpmrc(registry: string): string {
  const normalized = registry.endsWith('/') ? registry : `${registry}/`;
  return `registry=${normalized}\naudit=false\nfund=false\n`;
}
