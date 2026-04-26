import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Postgres migration journal', () => {
  it('applies the memory schema migration on fresh databases', () => {
    const journalPath = path.resolve(
      'apps/core/src/infrastructure/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };

    expect(journal.entries.map((entry) => entry.tag)).toContain('0005_memory');
  });

  it('applies the canonical domain cutover migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/infrastructure/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };

    expect(journal.entries.map((entry) => entry.tag)).toContain(
      '0008_canonical_domain_schema_cutover',
    );
  });

  it('recreates legacy memory tables during the canonical cutover', () => {
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/infrastructure/postgres/schema/migrations/0008_canonical_domain_schema_cutover.sql',
      ),
      'utf8',
    );

    expect(migration).toMatch(
      /DROP TABLE IF EXISTS memory_items CASCADE;[\s\S]*CREATE TABLE IF NOT EXISTS memory_items/,
    );
    expect(migration).toMatch(
      /DROP TABLE IF EXISTS memory_subjects CASCADE;[\s\S]*CREATE TABLE IF NOT EXISTS memory_subjects/,
    );
  });
});
