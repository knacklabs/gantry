import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Postgres migration journal', () => {
  it('applies the memory schema migration on fresh databases', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };

    expect(journal.entries.map((entry) => entry.tag)).toContain('0005_memory');
  });

  it('applies the canonical domain cutover migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };

    expect(journal.entries.map((entry) => entry.tag)).toContain(
      '0008_canonical_domain_schema_cutover',
    );
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      '0009_canonical_persistence_adapter_cut',
    );
  });

  it('flattens memory subjects during the canonical persistence cut', () => {
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0009_canonical_persistence_adapter_cut.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('DROP TABLE IF EXISTS memory_subjects CASCADE');
    expect(migration).toContain('CREATE TABLE memory_items');
    expect(migration).toContain('subject_type text NOT NULL');
    expect(migration).not.toContain('CREATE TABLE memory_subjects');
  });
});
