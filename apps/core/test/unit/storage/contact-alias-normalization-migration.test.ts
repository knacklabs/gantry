import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../../src/adapters/storage/postgres/schema/migrations/20260801175827_normalize_contact_aliases.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

describe('contact alias normalization migration', () => {
  it('aborts normalized active-alias collisions before updating rows', () => {
    const collisionGuard = migration.indexOf(
      'normalized values collide under the active alias unique index',
    );
    // The same-person dedup UPDATE intentionally precedes the guard; the
    // abort must precede the NORMALIZATION update specifically.
    const update = migration.indexOf(
      'UPDATE user_aliases\nSET\n  external_user_id = CASE',
    );

    expect(collisionGuard).toBeGreaterThan(-1);
    expect(collisionGuard).toBeLessThan(update);
    expect(migration).toContain('HAVING count(*) > 1');
  });

  it('rewrites live aliases unconditionally, retired ones only when they normalize cleanly', () => {
    const update = migration.slice(migration.indexOf('UPDATE user_aliases'));
    expect(update).toContain('AND retired_at IS NULL');
    const retiredUpdate = migration.slice(migration.indexOf('WITH contact'));
    expect(retiredUpdate).toContain('AND ua.retired_at IS NOT NULL');
    expect(retiredUpdate).toContain(String.raw`~ '^\+[1-9][0-9]{1,14}$'`);
    // Ambiguous tombstones stay untouched: normalization must not collapse
    // two people's aliases onto one key.
    expect(retiredUpdate).toContain('NOT EXISTS');
    expect(retiredUpdate).toContain('other.user_id <> c.user_id');
  });
});
