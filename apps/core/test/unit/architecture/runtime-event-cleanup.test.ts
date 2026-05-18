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

function collectRepoFiles(roots: string[], extensions: RegExp): string[] {
  return roots.flatMap((root) =>
    collectFiles(path.join(repoRoot, root))
      .filter((file) => extensions.test(file))
      .map((file) => path.relative(repoRoot, file)),
  );
}

describe('runtime event cleanup', () => {
  it('keeps runtime_events writes behind PostgresRuntimeEventRepository', () => {
    const sourceRoot = path.join(repoRoot, 'apps/core/src');
    const directInsertPatterns = [
      new RegExp(
        String.raw`\.insert\(\s*${['pgSchema', 'runtimeEventsPostgres'].join('\\.')}\s*\)`,
      ),
      /\.insert\(\s*runtimeEventsPostgres\s*\)/,
      /\binsert\s+into\s+(?:(?:"?[a-z_][a-z0-9_]*"?|\$\{[^}]+\})\s*\.\s*)?"?runtime_events"?\b/i,
    ];
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
          directInsertPatterns.some((pattern) => pattern.test(source)) &&
          !allowed.has(relativePath)
        );
      });

    expect(offenders).toEqual([]);
  });

  it('keeps speculative event queue and broker dependencies out of active runtime code', () => {
    const roots = [
      'apps/core/src',
      'apps/core/test',
      'packages/contracts/src',
      'packages/sdk/src',
      'apps/core/src/adapters/storage/postgres/schema/migrations',
    ];
    const packageFiles = ['package.json', 'package-lock.json'].filter((file) =>
      fs.existsSync(path.join(repoRoot, file)),
    );
    const allowedFiles = new Set([
      'apps/core/test/unit/architecture/runtime-event-cleanup.test.ts',
    ]);
    const allowedKafkaAdapterPrefix = 'apps/core/src/adapters/events/kafka/';
    const kafkaModule = String.raw`(?:kafkajs|node-rdkafka|@confluentinc\/[^'"]+)`;
    const kafkaImport = new RegExp(
      String.raw`(?:from\s+['"]${kafkaModule}['"]|import\s*\(\s*['"]${kafkaModule}['"]\s*\)|require\s*\(\s*['"]${kafkaModule}['"]\s*\))`,
    );
    const blockedPatterns: Array<[string, RegExp]> = [
      ['pgmq', /(^|[^a-z0-9_])pgmq([^a-z0-9_]|$)/i],
      ['UNLOGGED pub/sub table', /\bUNLOGGED\b/i],
      ['Kafka import', kafkaImport],
    ];
    const offenders = [
      ...collectRepoFiles(roots, /\.(ts|md|json|sql)$/),
      ...packageFiles,
    ].filter((relativePath) => {
      if (allowedFiles.has(relativePath)) return false;
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      return blockedPatterns.some(([name, pattern]) => {
        if (
          name === 'Kafka import' &&
          relativePath.startsWith(allowedKafkaAdapterPrefix)
        ) {
          return false;
        }
        return pattern.test(source);
      });
    });

    expect(offenders).toEqual([]);
  });

  it('keeps Kafka and queue backend config out of public runtime surfaces', () => {
    const roots = [
      'apps/core/src/config',
      'apps/core/src/cli',
      'packages/contracts/src',
      'packages/sdk/src',
    ];
    const forbiddenConfigPatterns = [
      /\bkafka\b/i,
      /\bKAFKA_[A-Z0-9_]+\b/,
      /\bpgmq\b/i,
      /\bevent[_-]?backend\b/i,
      /\bevent[_-]?provider\b/i,
    ];
    const offenders = collectRepoFiles(roots, /\.(ts|json)$/).filter(
      (relativePath) => {
        const source = fs.readFileSync(
          path.join(repoRoot, relativePath),
          'utf8',
        );
        return forbiddenConfigPatterns.some((pattern) => pattern.test(source));
      },
    );

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
    const offenders = collectRepoFiles(roots, /\.(ts|md)$/).filter(
      (relativePath) => {
        const source = fs.readFileSync(
          path.join(repoRoot, relativePath),
          'utf8',
        );
        return source.includes(retiredAcceptedEventAlias);
      },
    );

    expect(offenders).toEqual([]);
  });
});
