import { describe, expect, it } from 'vitest';

import {
  isValidNpmSpec,
  normalizeToolchainManifest,
  npmPackageName,
  renderBakeNpmrc,
  renderBakePackageJson,
  SYSTEM_PACKAGE_ERROR,
} from '@core/jobs/toolchain-bake-manifest.js';

const registry = 'https://registry.npmjs.org/';

describe('toolchain bake manifest', () => {
  it('accepts plain npm specs and scoped packages', () => {
    expect(isValidNpmSpec('left-pad')).toBe(true);
    expect(isValidNpmSpec('left-pad@1.3.0')).toBe(true);
    expect(isValidNpmSpec('@scope/pkg@^2.0.0')).toBe(true);
  });

  it('rejects non-npm/system specs', () => {
    expect(isValidNpmSpec('git+https://x/y.git')).toBe(false);
    expect(isValidNpmSpec('file:../local')).toBe(false);
    expect(isValidNpmSpec('../traversal')).toBe(false);
    expect(isValidNpmSpec('rm -rf /')).toBe(false);
    expect(isValidNpmSpec('https://example.com/pkg.tgz')).toBe(false);
  });

  it('extracts the package name from a spec', () => {
    expect(npmPackageName('left-pad@1.3.0')).toBe('left-pad');
    expect(npmPackageName('@scope/pkg@^2.0.0')).toBe('@scope/pkg');
    expect(npmPackageName('@scope/pkg')).toBe('@scope/pkg');
  });

  it('produces an order-independent manifest hash and sorts packages', () => {
    const a = normalizeToolchainManifest({
      packages: ['b@1.0.0', 'a@2.0.0'],
      registry,
    });
    const b = normalizeToolchainManifest({
      packages: ['a@2.0.0', 'b@1.0.0', 'a@2.0.0'],
      registry,
    });
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.packages).toEqual(['a@2.0.0', 'b@1.0.0']);
    expect(a.scriptAllowedPackages).toEqual([]);
  });

  it('throws the ADR-2 error on a system package spec', () => {
    expect(() =>
      normalizeToolchainManifest({ packages: ['ffmpeg!'], registry }),
    ).toThrow(new RegExp(SYSTEM_PACKAGE_ERROR));
  });

  it('renders package.json with name@version dependencies', () => {
    const json = JSON.parse(
      renderBakePackageJson(['left-pad@1.3.0', 'is-odd']),
    );
    expect(json.private).toBe(true);
    expect(json.dependencies).toEqual({ 'left-pad': '1.3.0', 'is-odd': '*' });
  });

  it('renders .npmrc pinning the registry with audit/fund off', () => {
    const npmrc = renderBakeNpmrc('https://mirror.internal/npm');
    expect(npmrc).toContain('registry=https://mirror.internal/npm/');
    expect(npmrc).toContain('audit=false');
    expect(npmrc).toContain('fund=false');
  });
});
