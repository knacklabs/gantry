import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Postgres migration journal', () => {
  it('has a SQL file for every journal entry', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };

    for (const entry of journal.entries) {
      expect(
        fs.existsSync(
          path.resolve(
            `apps/core/src/adapters/storage/postgres/schema/migrations/${entry.tag}.sql`,
          ),
        ),
      ).toBe(true);
    }
  });

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

  it('registers event bus outbox migration after runtime events', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const outbox = journal.entries.find(
      (entry) => entry.tag === '0048_event_bus_outbox',
    );
    expect(outbox).toMatchObject({ idx: 48 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0048_event_bus_outbox.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS event_bus_outbox');
    expect(migration).toContain(
      'runtime_event_id integer UNIQUE REFERENCES runtime_events(event_id) ON DELETE CASCADE',
    );
    expect(migration).toContain('occurred_at timestamptz NOT NULL');
    expect(migration).toContain('idx_event_bus_outbox_claim_due');
  });

  it('registers session memory boundary digests migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const boundaryDigest = journal.entries.find(
      (entry) => entry.tag === '0031_session_memory_boundary_digests',
    );
    expect(boundaryDigest).toMatchObject({ idx: 31 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0031_session_memory_boundary_digests.sql',
      ),
      'utf8',
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS agent_session_digests',
    );
    expect(migration).toContain('trigger text NOT NULL');
    expect(migration).toContain(
      'extracted_fact_count integer NOT NULL DEFAULT 0',
    );
  });

  it('registers memory thread scope hardening migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const threadScopeHardening = journal.entries.find(
      (entry) => entry.tag === '0033_memory_thread_scope_hardening',
    );
    expect(threadScopeHardening).toMatchObject({ idx: 33 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0033_memory_thread_scope_hardening.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS thread_id text');
    expect(migration).toContain("COALESCE(thread_id, '')");
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS memory_items_active_unique',
    );
  });

  it('registers thread-aware memory dreaming indexes migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const dreamingIndexes = journal.entries.find(
      (entry) => entry.tag === '0035_memory_dreaming_thread_indexes',
    );
    expect(dreamingIndexes).toMatchObject({ idx: 35 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0035_memory_dreaming_thread_indexes.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('idx_memory_evidence_boundary');
    expect(migration).toContain('thread_id');
    expect(migration).toContain('created_at DESC');
    expect(migration).toContain('idx_memory_candidates_boundary');
    expect(migration).toContain('status');
    expect(migration).toContain('confidence DESC');
  });

  it('registers dream guard and memory/message recall indexes migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const guardAndIndexes = journal.entries.find(
      (entry) => entry.tag === '0038_memory_dream_guards_and_recall_indexes',
    );
    expect(guardAndIndexes).toMatchObject({ idx: 38 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0038_memory_dream_guards_and_recall_indexes.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('idx_memory_dream_runs_running_unique');
    expect(migration).toContain("WHERE status = 'running'");
    expect(migration).toContain('idx_memory_items_subject_updated');
    expect(migration).toContain('thread_id');
    expect(migration).toContain('updated_at DESC');
    expect(migration).toContain('idx_messages_conversation_recent');
    expect(migration).toContain('created_at DESC');
  });

  it('registers memory dream run leases and all-phase guard indexes', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const dreamLeases = journal.entries.find(
      (entry) => entry.tag === '0039_memory_dream_run_leases',
    );
    expect(dreamLeases).toMatchObject({ idx: 39 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0039_memory_dream_run_leases.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('lease_expires_at timestamptz');
    expect(migration).toContain('ALTER COLUMN lease_expires_at SET NOT NULL');
    expect(migration).toContain('idx_memory_dream_runs_running_light_unique');
    expect(migration).toContain("phase IN ('all', 'light')");
    expect(migration).toContain("phase IN ('all', 'rem')");
    expect(migration).toContain("phase IN ('all', 'deep')");
    expect(migration).toContain("'light'::text");
    expect(migration).toContain("'rem'::text");
    expect(migration).toContain("'deep'::text");
  });

  it('registers canonical job target execution context migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const executionContextMigration = journal.entries.find(
      (entry) =>
        entry.tag === '0040_jobs_target_execution_context_notification_routes',
    );
    expect(executionContextMigration).toMatchObject({ idx: 40 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0040_jobs_target_execution_context_notification_routes.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('jobs.target_json migration requires');
    expect(migration).toContain("'executionContext'");
    expect(migration).toContain("'notificationRoutes'");
    expect(migration).toContain(
      "target_json::jsonb #>> '{executionContext,sessionId}'",
    );
    expect(migration).toContain('WHERE (');
    expect(migration).toContain("? 'linkedSessions'");
    expect(migration).toContain('notificationRoutes');
  });

  it('registers outbound claim and job target lookup indexes migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const performanceIndexes = journal.entries.find(
      (entry) => entry.tag === '0041_outbound_claim_and_job_target_indexes',
    );
    expect(performanceIndexes).toMatchObject({ idx: 41 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0041_outbound_claim_and_job_target_indexes.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('idx_outbound_delivery_items_claimed_expired');
    expect(migration).toContain("status = 'claimed'");
    expect(migration).toContain('idx_jobs_target_group_scope_updated');
    expect(migration).toContain('idx_jobs_target_thread_normalized_updated');
    expect(migration).toContain('idx_jobs_target_notification_routes');
    expect(migration).toContain('USING gin');
  });

  it('registers provider session resume lookup index migration and schema', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const resumeLookup = journal.entries.find(
      (entry) => entry.tag === '0042_provider_session_resume_lookup_index',
    );
    expect(resumeLookup).toMatchObject({ idx: 42 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0042_provider_session_resume_lookup_index.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('idx_provider_sessions_resume_lookup');
    expect(migration).toContain(
      'ON provider_sessions(agent_session_id, provider, status, updated_at DESC)',
    );

    const schema = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/sessions.ts',
      ),
      'utf8',
    );
    expect(schema).toContain(
      "resumeLookupIdx: index('idx_provider_sessions_resume_lookup')",
    );
    expect(schema).toContain('table.agentSessionId');
    expect(schema).toContain('table.provider');
    expect(schema).toContain('table.status');
    expect(schema).toContain('table.updatedAt.desc()');
  });

  it('registers provider-agnostic provider session resume lookup index migration and schema', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const resumeLookup = journal.entries.find(
      (entry) =>
        entry.tag ===
        '0044_provider_session_provider_agnostic_resume_lookup_index',
    );
    expect(resumeLookup).toMatchObject({ idx: 44 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0044_provider_session_provider_agnostic_resume_lookup_index.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('idx_provider_sessions_agent_status_updated');
    expect(migration).toContain(
      'ON provider_sessions(agent_session_id, status, updated_at DESC)',
    );

    const schema = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/sessions.ts',
      ),
      'utf8',
    );
    expect(schema).toContain('providerAgnosticResumeLookupIdx: index(');
    expect(schema).toContain("'idx_provider_sessions_agent_status_updated'");
    expect(schema).toContain('table.agentSessionId');
    expect(schema).toContain('table.status');
    expect(schema).toContain('table.updatedAt.desc()');
  });

  it('registers message attachment message lookup index migration and schema', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const attachmentLookup = journal.entries.find(
      (entry) => entry.tag === '0043_message_attachments_message_lookup_index',
    );
    expect(attachmentLookup).toMatchObject({ idx: 43 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0043_message_attachments_message_lookup_index.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('idx_message_attachments_message_id');
    expect(migration).toContain('ON message_attachments(message_id, id)');

    const schema = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/messages.ts',
      ),
      'utf8',
    );
    expect(schema).toContain(
      "messageLookupIdx: index('idx_message_attachments_message_id')",
    );
    expect(schema).toContain('table.messageId');
    expect(schema).toContain('table.id');
  });

  it('registers scope-key and digest scope columns/indexes without legacy backfill', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const scopeMigration = journal.entries.find(
      (entry) =>
        entry.tag === '0046_session_scope_indexes_and_digest_scope_filters',
    );
    expect(scopeMigration).toMatchObject({ idx: 46 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0046_session_scope_indexes_and_digest_scope_filters.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS scope_key text');
    expect(migration).toContain('idx_agent_sessions_app_scope_key');
    expect(migration).toContain('idx_agent_sessions_app_scope_key_prefix');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS scope_app_id text');
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS scope_thread_id text',
    );
    expect(migration).toContain('idx_agent_session_digests_scope_created');

    expect(migration).not.toContain('UPDATE agent_sessions');
    expect(migration).not.toContain("id LIKE 'agent-session:");
    expect(migration).not.toContain('metadata_json::jsonb');
    expect(migration).not.toContain('{sessionScope,');
    expect(migration).not.toContain('UPDATE agent_session_digests');
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

  it('registers outbound delivery fingerprint hash normalization migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const fingerprintNormalization = journal.entries.find(
      (entry) =>
        entry.tag === '0037_outbound_delivery_fingerprint_hash_normalization',
    );
    expect(fingerprintNormalization).toMatchObject({ idx: 37 });

    const migration0036 = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0036_outbound_delivery_idempotency_fingerprint_and_scope.sql',
      ),
      'utf8',
    );
    expect(migration0036).toContain(
      'idx_outbound_deliveries_app_profile_status_updated',
    );

    const migration0037 = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0037_outbound_delivery_fingerprint_hash_normalization.sql',
      ),
      'utf8',
    );
    expect(migration0037).toContain(
      "idempotency_fingerprint ~ '^sha256:[0-9a-f]{64}$'",
    );
    expect(migration0037).toContain(
      "digest(idempotency_fingerprint, 'sha256')",
    );
  });
});
