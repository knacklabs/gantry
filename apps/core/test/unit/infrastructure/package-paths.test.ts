import path from 'path';
import { pathToFileURL } from 'url';

import { describe, expect, it } from 'vitest';

import {
  getDistRoot,
  getPackageRoot,
  getRuntimeEntryPath,
} from '@core/infrastructure/service/package-paths.js';

describe('service package paths', () => {
  it('resolves package dist paths from built CLI import URLs', () => {
    const packageRoot = path.join('/tmp', 'gantry-package');
    const importMetaUrl = pathToFileURL(
      path.join(packageRoot, 'dist', 'cli', 'index.js'),
    ).href;

    expect(getDistRoot(importMetaUrl)).toBe(path.join(packageRoot, 'dist'));
    expect(getPackageRoot(importMetaUrl)).toBe(packageRoot);
    expect(getRuntimeEntryPath(importMetaUrl)).toBe(
      path.join(packageRoot, 'dist', 'index.js'),
    );
  });

  it('resolves package dist paths from dev checkout CLI import URLs', () => {
    const packageRoot = path.join('/tmp', 'Agent.Gantry');
    const importMetaUrl = pathToFileURL(
      path.join(packageRoot, 'apps', 'core', 'src', 'cli', 'index.ts'),
    ).href;

    expect(getDistRoot(importMetaUrl)).toBe(path.join(packageRoot, 'dist'));
    expect(getPackageRoot(importMetaUrl)).toBe(packageRoot);
    expect(getRuntimeEntryPath(importMetaUrl)).toBe(
      path.join(packageRoot, 'dist', 'index.js'),
    );
  });
});
