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
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      '0015_skill_draft_artifacts',
    );
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      '0017_agent_run_session_delete_policy',
    );
  });

  it('keeps runtime event exchange after the shipped session delete policy migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const sessionDeletePolicy = journal.entries.find(
      (entry) => entry.tag === '0017_agent_run_session_delete_policy',
    );
    const runtimeExchange = journal.entries.find(
      (entry) => entry.tag === '0018_runtime_event_exchange',
    );

    expect(sessionDeletePolicy).toMatchObject({ idx: 17 });
    expect(runtimeExchange).toMatchObject({ idx: 18 });
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
      'conversation_id text REFERENCES conversations',
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
      'session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL',
    );
    expect(migration).toContain(
      'permission_decision_id text NOT NULL REFERENCES permission_decisions(id)',
    );
    const providerConversationRenameMigration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0024_provider_conversation_rename.sql',
      ),
      'utf8',
    );
    expect(providerConversationRenameMigration).toContain(
      'RENAME COLUMN channel_installation_id TO provider_connection_id',
    );
    expect(providerConversationRenameMigration).toContain(
      'RENAME COLUMN channel_provider TO provider',
    );

    const sessionDeletePolicyMigration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0017_agent_run_session_delete_policy.sql',
      ),
      'utf8',
    );
    expect(sessionDeletePolicyMigration).toContain('FOREIGN KEY (session_id)');
    expect(sessionDeletePolicyMigration).toContain(
      'REFERENCES agent_sessions(id)',
    );
    expect(sessionDeletePolicyMigration).toContain('ON DELETE SET NULL');
  });

  it('keeps skill draft persistence indexes aligned with one binding per agent skill', () => {
    const canonicalMigration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0009_canonical_persistence_adapter_cut.sql',
      ),
      'utf8',
    );
    const skillMigration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0015_skill_draft_artifacts.sql',
      ),
      'utf8',
    );
    const skillOwnerScopedMigration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0028_skill_catalog_owner_scoped_uniqueness.sql',
      ),
      'utf8',
    );
    const repository = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/repositories/skill-repository.postgres.ts',
      ),
      'utf8',
    );

    expect(canonicalMigration).toContain(
      'ON agent_skill_bindings(app_id, agent_id, skill_id)',
    );
    expect(skillMigration).toContain(
      'ON agent_skill_bindings(app_id, agent_id, skill_id)',
    );
    expect(skillMigration).toContain('ADD COLUMN IF NOT EXISTS rejected_by');
    expect(skillMigration).toContain('ADD COLUMN IF NOT EXISTS rejected_at');
    expect(skillMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_app_hash',
    );
    expect(skillOwnerScopedMigration).toContain(
      "ON skill_catalog(app_id, (coalesce(agent_id, '')), content_hash)",
    );
    expect(skillOwnerScopedMigration).toContain('row_number() OVER (');
    expect(skillOwnerScopedMigration).toContain(
      'UPDATE agent_skill_bindings b',
    );
    expect(skillOwnerScopedMigration).toContain(
      'SET skill_id = ranked_content_hashes.keep_id',
    );
    expect(skillOwnerScopedMigration).toContain(
      'SET skill_id = ranked_names.keep_id',
    );
    expect(skillOwnerScopedMigration).toContain(
      'WHERE content_hash IS NOT NULL',
    );
    expect(skillOwnerScopedMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_app_hash',
    );
    expect(skillOwnerScopedMigration).toContain(
      "ON skill_catalog(app_id, (coalesce(agent_id, '')), name, version)",
    );
    expect(repository).toContain(
      'coalesce(${pgSchema.skillCatalogPostgres.agentId}',
    );
    expect(repository).toContain('configVersionId: binding.configVersionId');
  });
});
