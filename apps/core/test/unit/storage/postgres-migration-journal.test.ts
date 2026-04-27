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
    const memoryTable = migration.slice(
      migration.indexOf('CREATE TABLE memory_items'),
      migration.indexOf('CREATE UNIQUE INDEX memory_items_active_unique'),
    );

    expect(memoryTable).toContain('CREATE TABLE memory_items');
    expect(memoryTable).toContain('subject_type text NOT NULL');
    expect(memoryTable).toContain('agent_id text');
    expect(memoryTable).toContain('conversation_id text');
    expect(memoryTable).not.toContain('agent_id text REFERENCES agents');
    expect(memoryTable).not.toContain(
      'conversation_id text REFERENCES channel_conversations',
    );
    expect(memoryTable).not.toContain('user_id text REFERENCES users');
    expect(migration).not.toContain('CREATE TABLE memory_subjects');
  });

  it('keeps canonical schema and destructive migration foreign keys aligned', () => {
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0009_canonical_persistence_adapter_cut.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'agent_id text REFERENCES agents(id) ON DELETE SET NULL',
    );
    expect(migration).toContain(
      'workspace_snapshot_id text REFERENCES workspace_snapshots(id)',
    );
    expect(migration).toContain(
      'run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE',
    );
    expect(migration).toContain(
      'permission_decision_id text NOT NULL REFERENCES permission_decisions(id)',
    );
    expect(migration).toContain('channel_installation_id text,');
    expect(migration).toContain('channel_installation_id text NOT NULL,');
  });
});
