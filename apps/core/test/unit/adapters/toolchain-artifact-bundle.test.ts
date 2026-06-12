import { describe, expect, it } from 'vitest';

import {
  normalizeToolchainPath,
  normalizeToolchainStorageRef,
  resolveToolchainAssetPath,
  resolveToolchainSymlinkTarget,
} from '@core/adapters/artifacts/toolchains/toolchain-artifact-bundle.js';

// These guards are the only defense preventing an untrusted toolchain artifact
// (bytes fetched from S3/registry and written to disk on every fleet worker)
// from materializing a symlink or file outside its content-addressed root.
// A regression that weakened any rejection branch must fail a test here.
describe('toolchain artifact path/symlink traversal guards', () => {
  const root = '/tmp/tc-root';
  const NUL = String.fromCharCode(0);

  describe('resolveToolchainSymlinkTarget', () => {
    it('accepts a valid relative target that stays inside the root', () => {
      expect(
        resolveToolchainSymlinkTarget(
          root,
          'node_modules/.bin/cli',
          '../tool/bin/cli.js',
        ),
      ).toBe('../tool/bin/cli.js');
    });

    it('rejects absolute POSIX targets', () => {
      expect(() =>
        resolveToolchainSymlinkTarget(root, 'a/link', '/etc/passwd'),
      ).toThrow(/symlink target/);
    });

    it('rejects Windows drive-letter targets', () => {
      expect(() =>
        resolveToolchainSymlinkTarget(root, 'a/link', 'C:/Windows/system32'),
      ).toThrow(/symlink target/);
    });

    it('rejects targets that escape the root via ..', () => {
      expect(() =>
        resolveToolchainSymlinkTarget(
          root,
          'a/b/link',
          '../../../../etc/passwd',
        ),
      ).toThrow(/symlink target/);
    });

    it('rejects null-byte and empty targets', () => {
      expect(() =>
        resolveToolchainSymlinkTarget(root, 'a/link', `x${NUL}y`),
      ).toThrow(/symlink target/);
      expect(() => resolveToolchainSymlinkTarget(root, 'a/link', '')).toThrow(
        /symlink target/,
      );
    });
  });

  describe('normalizeToolchainPath / normalizeToolchainStorageRef', () => {
    const bad = [
      '../escape',
      './here',
      '/abs/path',
      'C:/win',
      'a/../../b',
      'a//b',
      `has${NUL}nul`,
      '',
    ];
    for (const value of bad) {
      it(`normalizeToolchainPath rejects ${JSON.stringify(value)}`, () => {
        expect(() => normalizeToolchainPath(value)).toThrow(/artifact path/);
      });
      it(`normalizeToolchainStorageRef rejects ${JSON.stringify(value)}`, () => {
        expect(() => normalizeToolchainStorageRef(value)).toThrow(
          /storage ref/,
        );
      });
    }

    it('normalizes backslashes and preserves valid nested paths', () => {
      expect(normalizeToolchainPath('a\\b\\c.js')).toBe('a/b/c.js');
      expect(normalizeToolchainPath('node_modules/pkg/index.js')).toBe(
        'node_modules/pkg/index.js',
      );
    });
  });

  describe('resolveToolchainAssetPath', () => {
    it('resolves a valid relative asset under the root', () => {
      expect(resolveToolchainAssetPath(root, 'pkg/index.js')).toBe(
        '/tmp/tc-root/pkg/index.js',
      );
    });

    it('rejects traversal and absolute asset paths', () => {
      for (const value of ['../escape', '/etc/passwd', 'a/../../b']) {
        expect(() => resolveToolchainAssetPath(root, value)).toThrow(
          /artifact path/,
        );
      }
    });
  });
});
