import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCAN_ROOTS = ['apps/core/src/adapters/storage/postgres'];

const ALLOWED_RAW_SQL_FILES = new Set([
  'apps/core/src/adapters/storage/postgres/repositories/file-artifact-repository.postgres.ts',
  // pg_advisory_xact_lock guards run-slot capacity checks against concurrent
  // acquisition; same operational primitive as the file-artifact path lock.
  'apps/core/src/adapters/storage/postgres/repositories/worker-coordination-lease.postgres.ts',
  // pg_advisory_xact_lock makes async task admission atomic across workers.
  'apps/core/src/adapters/storage/postgres/repositories/async-task-repository.postgres.ts',
  // pg_advisory_xact_lock makes Observer batch claiming atomic across workers
  // (prefer-orphan state machine); same operational primitive as above.
  'apps/core/src/adapters/storage/postgres/repositories/chat-batch-repository.postgres.ts',
  // LISTEN/NOTIFY is wakeup-only; durable rows remain authoritative.
  'apps/core/src/adapters/storage/postgres/live-admission-notify.postgres.ts',
  'apps/core/src/adapters/storage/postgres/runtime-event-notifier.postgres.ts',
  'apps/core/src/adapters/storage/postgres/runtime-store.ts',
  'apps/core/src/adapters/storage/postgres/storage-service.ts',
]);

const RAW_SQL_PATTERN =
  /\b(?:pool|client|db)\.query\b|\.execute\(sql|pg_notify|pg_advisory|pg_try_advisory/g;

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath.includes(`${path.sep}schema${path.sep}migrations`)) {
        return [];
      }
      return listSourceFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('Postgres raw SQL allowlist', () => {
  it('keeps active raw driver SQL limited to operational primitives', () => {
    const violations: string[] = [];
    for (const scanRoot of SCAN_ROOTS) {
      for (const file of listSourceFiles(path.join(ROOT, scanRoot))) {
        const relativePath = path.relative(ROOT, file);
        const text = fs.readFileSync(file, 'utf8');
        const matches = [...text.matchAll(RAW_SQL_PATTERN)];
        if (matches.length === 0 || ALLOWED_RAW_SQL_FILES.has(relativePath)) {
          continue;
        }
        violations.push(
          `${relativePath}: ${matches.map((match) => match[0]).join(', ')}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
