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
  // pg_advisory_xact_lock makes live admission cap checks atomic per app.
  'apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts',
  // pg_advisory_xact_lock makes Observer batch claiming atomic across workers
  // (prefer-orphan state machine); same operational primitive as above.
  'apps/core/src/adapters/storage/postgres/repositories/chat-batch-repository.postgres.ts',
  // Identity alias and merge mutations use transaction-scoped advisory locks
  // to make exact-key resolution and merge idempotency atomic.
  'apps/core/src/adapters/storage/postgres/repositories/person-identity-mappers.postgres.ts',
  'apps/core/src/adapters/storage/postgres/repositories/person-identity-repository.postgres.ts',
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

describe('person identity migration contract', () => {
  it('retires duplicate active aliases before adding coalesced uniqueness', () => {
    const migration = fs.readFileSync(
      path.join(
        ROOT,
        'apps/core/src/adapters/storage/postgres/schema/migrations/0116_person_identity_management.sql',
      ),
      'utf8',
    );
    const retirement = migration.indexOf(
      'migration:0102_duplicate_alias_retirement',
    );
    const uniqueIndex = migration.indexOf(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_aliases_active_provider_external',
    );

    expect(retirement).toBeGreaterThanOrEqual(0);
    expect(uniqueIndex).toBeGreaterThan(retirement);
    expect(migration).toContain('row_number() OVER');
    expect(migration).toContain("COALESCE(provider_account_id, '')");
    expect(migration).toContain('COUNT(DISTINCT user_id) > 1');
    expect(migration).toContain('RAISE EXCEPTION');
  });

  it('adds the merge result payload required by the active schema', () => {
    const migration = fs.readFileSync(
      path.join(
        ROOT,
        'apps/core/src/adapters/storage/postgres/schema/migrations/0119_person_merge_audit_result.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS result_json jsonb');
  });

  it('cleans non-person memory user ids before adding the app-scoped memory foreign key', () => {
    const migration = fs.readFileSync(
      path.join(
        ROOT,
        'apps/core/src/adapters/storage/postgres/schema/migrations/0121_identity_app_scoped_person_foreign_keys.sql',
      ),
      'utf8',
    );
    const cleanup = migration.indexOf(
      "WHERE subject_type <> 'user'\n  AND user_id IS NOT NULL",
    );
    const memoryForeignKey = migration.indexOf(
      'ADD CONSTRAINT memory_items_app_user_fk',
    );

    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(memoryForeignKey).toBeGreaterThan(cleanup);
    expect(migration).toContain('SET user_id = NULL');
    expect(migration).toContain('FOREIGN KEY (app_id, user_id)');
    expect(migration).toContain('REFERENCES users (app_id, id)');
  });
});
