import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

function collectFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(absolute));
      continue;
    }
    out.push(absolute);
  }
  return out;
}

describe('runtime event cleanup', () => {
  it('keeps runtime_events writes behind PostgresRuntimeEventRepository', () => {
    const sourceRoot = path.join(repoRoot, 'apps/core/src');
    const directInsertNeedle = `.insert(${['pgSchema', 'runtimeEventsPostgres'].join('.')})`;
    const allowed = new Set([
      'apps/core/src/adapters/storage/postgres/repositories/runtime-event-repository.postgres.ts',
    ]);
    const offenders = collectFiles(sourceRoot)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => path.relative(repoRoot, file))
      .filter((relativePath) => {
        const source = fs.readFileSync(
          path.join(repoRoot, relativePath),
          'utf8',
        );
        return (
          source.includes(directInsertNeedle) && !allowed.has(relativePath)
        );
      });

    expect(offenders).toEqual([]);
  });

  it('removes the retired accepted runtime event alias from active code and docs', () => {
    const retiredAcceptedEventAlias = ['session', 'message', 'accepted'].join(
      '.',
    );
    const roots = [
      'apps/core/src',
      'apps/core/test',
      'packages/contracts/src',
      'packages/sdk/src',
      'docs',
    ];
    const offenders = roots.flatMap((root) =>
      collectFiles(path.join(repoRoot, root))
        .filter((file) => /\.(ts|md)$/.test(file))
        .map((file) => path.relative(repoRoot, file))
        .filter((relativePath) => {
          const source = fs.readFileSync(
            path.join(repoRoot, relativePath),
            'utf8',
          );
          return source.includes(retiredAcceptedEventAlias);
        }),
    );

    expect(offenders).toEqual([]);
  });
});
