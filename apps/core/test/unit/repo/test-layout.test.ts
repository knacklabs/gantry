import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function collectSourceAdjacentTests(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...collectSourceAdjacentTests(fullPath));
      continue;
    }
    if (/\.(test|spec)\.ts$/.test(entry.name)) {
      matches.push(path.relative(repoRoot, fullPath));
    }
  }
  return matches.sort();
}

describe('repo test layout', () => {
  it('keeps tests out of source directories', () => {
    expect(
      collectSourceAdjacentTests(path.join(repoRoot, 'apps/core/src')),
    ).toEqual([]);
    expect(
      collectSourceAdjacentTests(path.join(repoRoot, 'packages/contracts/src')),
    ).toEqual([]);
  });
});
