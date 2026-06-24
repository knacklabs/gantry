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

  it('registers the semantic memory vectors migration and schema', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find(
      (item) => item.tag === '0070_semantic_memory_vectors',
    );
    expect(entry).toMatchObject({ idx: 70 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0070_semantic_memory_vectors.sql',
      ),
      'utf8',
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS embedding vector(1536)',
    );
    expect(migration).toContain('USING hnsw (embedding vector_cosine_ops)');
    expect(migration).toContain(
      "WHERE status = 'ready' AND embedding IS NOT NULL",
    );
    expect(migration).toContain('idx_memory_item_embeddings_ready_lookup');
    expect(migration).toContain(
      'ON memory_item_embeddings(provider, model, status, provider_batch_id, updated_at, item_id)',
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS memory_embedding_backfill_runs',
    );
    expect(migration).toContain('run_id uuid');
    expect(migration).toContain('idx_memory_embedding_backfill_runs_running');
    expect(migration).toContain("WHERE status = 'running' AND mode = 'inline'");

    const schema = fs.readFileSync(
      path.resolve('apps/core/src/adapters/storage/postgres/schema/schema.ts'),
      'utf8',
    );
    expect(schema).toContain('memoryEmbeddingBackfillRunsPostgres');
    expect(schema).toContain("vector('embedding', { dimensions: 1536 })");
    expect(schema).toContain('idx_memory_item_embeddings_hnsw');
    expect(schema).toContain('idx_memory_item_embeddings_ready_lookup');
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

  it('keeps the job workspace-key cutover fail-closed', () => {
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0071_jobs_target_workspace_key_cutover.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration).toContain('executionContext.workspaceKey');
    expect(migration).toContain('idx_jobs_target_workspace_key_updated');
    expect(migration).not.toContain('jsonb_set(');
    expect(migration).not.toContain("#- '{executionContext,groupScope}'");
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

  it('keeps JSONB performance indexes narrow and operator-specific', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const jsonbIndexPerformance = journal.entries.find(
      (entry) => entry.tag === '0056_jsonb_index_performance',
    );
    expect(jsonbIndexPerformance).toMatchObject({ idx: 56 });

    const migration55 = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0055_runtime_payload_jsonb_columns.sql',
      ),
      'utf8',
    );
    const migration56 = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0056_jsonb_index_performance.sql',
      ),
      'utf8',
    );
    const controlSchema = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/control-http.ts',
      ),
      'utf8',
    );
    const jobsSchema = fs.readFileSync(
      path.resolve('apps/core/src/adapters/storage/postgres/schema/jobs.ts'),
      'utf8',
    );

    expect(migration55).not.toContain(
      'ON control_http_sessions USING gin (external_ref_json)',
    );
    expect(migration55).toContain(
      "ON jobs USING gin ((coalesce(target_json -> 'notificationRoutes', '[]'::jsonb)) jsonb_path_ops)",
    );
    expect(migration56).toContain(
      'DROP INDEX IF EXISTS idx_control_http_sessions_external_ref',
    );
    expect(migration56).toContain(
      "ON jobs USING gin ((coalesce(target_json -> 'notificationRoutes', '[]'::jsonb)) jsonb_path_ops)",
    );
    expect(controlSchema).not.toContain(
      'idx_control_http_sessions_external_ref',
    );
    expect(jobsSchema).toContain('jsonb_path_ops');
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

  it('registers execution provider id run backfill and provider session cutover', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const runBackfill = journal.entries.find(
      (entry) => entry.tag === '0057_agent_run_execution_provider',
    );
    expect(runBackfill).toMatchObject({ idx: 57 });
    const providerCutover = journal.entries.find(
      (entry) => entry.tag === '0058_anthropic_execution_provider_id_cutover',
    );
    expect(providerCutover).toMatchObject({ idx: 58 });

    const runMigration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0057_agent_run_execution_provider.sql',
      ),
      'utf8',
    );
    expect(runMigration).toContain('UPDATE agent_runs');
    expect(runMigration).toContain(
      "execution_provider_id = 'anthropic:claude-agent-sdk'",
    );
    expect(runMigration).toContain('agent_runs_execution_provider_id_safe');
    expect(runMigration).toContain(
      'ADD COLUMN IF NOT EXISTS execution_provider_id text',
    );
    expect(runMigration).toContain("execution_provider_id !~ '^unconfigured:'");
    expect(runMigration).not.toContain('SET DEFAULT');

    const providerMigration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0058_anthropic_execution_provider_id_cutover.sql',
      ),
      'utf8',
    );
    expect(providerMigration).not.toContain('UPDATE agent_runs');
    expect(providerMigration).toContain('UPDATE provider_sessions');
    expect(providerMigration).toContain(
      "provider = 'anthropic:claude-agent-sdk'",
    );
    expect(providerMigration).toContain(
      'provider_ref_json = jsonb_build_object',
    );
    expect(providerMigration).toContain("'anthropic:claude-agent-sdk:' ||");
    expect(providerMigration).toContain(
      "'provider', 'anthropic:claude-agent-sdk'",
    );
    expect(providerMigration).toContain("'anthropic-claude-agent-sdk'");
    expect(providerMigration).toContain(
      "provider IN ('anthropic', 'anthropic-claude-agent-sdk')",
    );
    expect(providerMigration).toContain(
      "external_session_id !~ '^anthropic:claude-agent-sdk:'",
    );
    expect(providerMigration).toContain('FOR UPDATE SKIP LOCKED');
    expect(providerMigration).not.toContain('updated_at = now()');
    expect(providerMigration).toContain(
      "provider_ref_json->>'provider' IN ('anthropic', 'anthropic-claude-agent-sdk')",
    );
  });

  it('registers LLM profile response family cutover with audit snapshot and validated constraint', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const responseFamilyCutover = journal.entries.find(
      (entry) => entry.tag === '0064_llm_profile_response_family',
    );
    expect(responseFamilyCutover).toMatchObject({ idx: 64 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0064_llm_profile_response_family.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('RENAME COLUMN provider TO response_family');
    expect(migration).toContain('ADD COLUMN response_family text NOT NULL');
    expect(migration).toContain('ALTER COLUMN response_family SET DEFAULT');
    expect(migration).toContain('ALTER COLUMN response_family SET NOT NULL');
    expect(migration).toContain('llm_profiles_response_family_legacy');
    expect(migration).toContain("WHEN response_family = 'openai'");
    expect(migration).toContain(
      'ADD CONSTRAINT llm_profiles_response_family_valid',
    );
    expect(migration).toContain('NOT VALID');
    expect(migration).toContain(
      'VALIDATE CONSTRAINT llm_profiles_response_family_valid',
    );
    expect(migration).not.toContain("SET model_alias = 'opus'");
  });

  it('registers LLM profile model alias cutover separately with audit snapshot', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const modelAliasCutover = journal.entries.find(
      (entry) => entry.tag === '0065_llm_profile_model_alias_cutover',
    );
    expect(modelAliasCutover).toMatchObject({ idx: 65 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0065_llm_profile_model_alias_cutover.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('llm_profiles_model_alias_legacy');
    expect(migration).toContain(
      "model_alias IN ('default', 'runtime-default')",
    );
    expect(migration).toContain("SET model_alias = 'opus'");
  });

  it('registers memory conversation-scope cutover migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const memoryScopeCutover = journal.entries.find(
      (entry) => entry.tag === '0066_memory_conversation_scope_cutover',
    );
    expect(memoryScopeCutover).toMatchObject({ idx: 66 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0066_memory_conversation_scope_cutover.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('SET thread_id = NULL');
    expect(migration).toContain(
      'DROP INDEX IF EXISTS memory_items_active_unique',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS memory_items_active_unique',
    );
    expect(migration).not.toContain("COALESCE(thread_id, '')");
  });

  it('keeps pending skill and MCP drafts disabled during simple capability cutover', () => {
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0069_simple_capability_lifecycle.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      "WHEN status IN ('active', 'approved') THEN 'installed'",
    );
    expect(migration).toContain(
      "WHEN status IN ('draft', 'rejected') THEN 'disabled'",
    );
    expect(migration).toContain(
      "WHEN status IN ('approved', 'active') THEN 'active'",
    );
    expect(migration).toContain("WHEN status = 'draft' THEN 'disabled'");
    expect(migration).not.toContain("'draft') THEN 'installed'");
    expect(migration).not.toContain("'draft', 'active') THEN 'active'");
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

  it('registers runtime payload jsonb column conversion migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const jsonbPayloads = journal.entries.find(
      (entry) => entry.tag === '0055_runtime_payload_jsonb_columns',
    );
    expect(jsonbPayloads).toMatchObject({ idx: 55 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0055_runtime_payload_jsonb_columns.sql',
      ),
      'utf8',
    );
    for (const statement of [
      'ALTER COLUMN external_ref_json TYPE jsonb USING external_ref_json::jsonb',
      'ALTER COLUMN payload_json TYPE jsonb USING payload_json::jsonb',
      'ALTER COLUMN provider_ref_json TYPE jsonb USING provider_ref_json::jsonb',
      'ALTER COLUMN metadata_json TYPE jsonb USING metadata_json::jsonb',
      'ALTER COLUMN schedule_json TYPE jsonb USING schedule_json::jsonb',
      'ALTER COLUMN target_json TYPE jsonb USING target_json::jsonb',
      'ALTER COLUMN value_json TYPE jsonb USING value_json::jsonb',
      'ALTER COLUMN source_ref_json TYPE jsonb USING source_ref_json::jsonb',
      "ON jobs ((target_json #>> '{executionContext,sessionId}')",
      "COALESCE(value_json->>'value', '')",
    ]) {
      expect(migration).toContain(statement);
    }
    expect(migration).not.toContain('NULLIF(');
    expect(migration).not.toContain('jsonb_strip_nulls');
    expect(migration).not.toContain('target_json::jsonb #>>');
    expect(migration).not.toContain('value_json::jsonb->>');
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

  it('keeps skill persistence indexes aligned with one binding per agent skill', () => {
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
    const simpleCapabilityMigration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0069_simple_capability_lifecycle.sql',
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
    expect(simpleCapabilityMigration).toContain(
      'DROP INDEX IF EXISTS idx_skill_catalog_app_hash',
    );
    expect(simpleCapabilityMigration).toContain('ranked_skill_slugs');
    expect(simpleCapabilityMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_app_skill_slug_installed',
    );
    expect(repository).not.toContain(
      'coalesce(${pgSchema.skillCatalogPostgres.agentId}',
    );
    expect(repository).toContain('configVersionId: binding.configVersionId');
  });

  it('registers skill action permissions storage and repository mapping', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0062_skill_action_permissions.sql',
      ),
      'utf8',
    );
    const schema = fs.readFileSync(
      path.resolve('apps/core/src/adapters/storage/postgres/schema/skills.ts'),
      'utf8',
    );
    const repository = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/repositories/skill-repository.postgres.ts',
      ),
      'utf8',
    );

    expect(
      journal.entries.find(
        (entry) => entry.tag === '0062_skill_action_permissions',
      ),
    ).toMatchObject({ idx: 62 });
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS action_permissions_json',
    );
    expect(schema).toContain('actionPermissionsJson');
    expect(migration).toContain('action_permissions_json jsonb');
    expect(migration).toContain('TYPE jsonb');
    expect(migration).toContain("SET DEFAULT '[]'::jsonb");
    expect(migration).toContain('SET NOT NULL');
    expect(schema).toContain("jsonb('action_permissions_json')");
    expect(repository).toContain(
      'actionPermissionsJson: item.actionPermissions ?? []',
    );
    expect(repository).toContain(
      'actionPermissions: parseJsonArray(row.actionPermissionsJson)',
    );
  });

  it('registers agent tool source attachment storage and repository mapping', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0063_agent_tool_sources.sql',
      ),
      'utf8',
    );
    const schema = fs.readFileSync(
      path.resolve('apps/core/src/adapters/storage/postgres/schema/tools.ts'),
      'utf8',
    );
    const repository = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/repositories/tool-repository.postgres.ts',
      ),
      'utf8',
    );

    expect(
      journal.entries.find((entry) => entry.tag === '0063_agent_tool_sources'),
    ).toMatchObject({ idx: 63 });
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS agent_tool_sources',
    );
    expect(migration).toContain('version text NOT NULL');
    expect(migration).toContain(
      'ON agent_tool_sources(app_id, agent_id, source_id, kind, version)',
    );
    expect(schema).toContain('agentToolSourcesPostgres');
    expect(repository).toContain('replaceAgentToolSources');
    expect(repository).toContain('listAgentToolSourcesForAgents');
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

  it('registers provider-native tool catalog cleanup migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const cleanup = journal.entries.find(
      (entry) => entry.tag === '0059_remove_provider_native_tool_catalog',
    );
    expect(cleanup).toMatchObject({ idx: 59 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0059_remove_provider_native_tool_catalog.sql',
      ),
      'utf8',
    );
    expect(migration).toContain(`kind = '${['anthropic', 'sdk'].join('_')}'`);
    expect(migration).toContain(`provider = 'anth${'ropic'}'`);
    expect(migration).toContain("adapter_ref = 'builtin:WebSearch'");
    expect(migration).toContain("name <> 'WebSearch'");
    expect(migration).toContain("'tool:Read'");
    expect(migration).toContain('BEGIN;');
    expect(migration).toContain(
      'CREATE TEMP TABLE provider_native_tool_cleanup_ids',
    );
    expect(migration).toContain('tool:removed-provider-native-sdk:');
    expect(migration).toContain('UPDATE permission_decisions');
    expect(migration).toContain('DELETE FROM agent_tool_bindings');
    expect(migration).toContain('DELETE FROM tool_catalog');
    expect(migration).toContain('COMMIT;');
  });

  it('registers agent run provider index migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const providerIndexes = journal.entries.find(
      (entry) => entry.tag === '0060_agent_run_provider_indexes',
    );
    expect(providerIndexes).toMatchObject({ idx: 60 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0060_agent_run_provider_indexes.sql',
      ),
      'utf8',
    );
    expect(migration).toContain(
      'DROP INDEX IF EXISTS idx_agent_runs_execution_provider',
    );
    expect(migration).toContain('idx_agent_runs_provider_session');
    expect(migration).toContain('idx_agent_runs_lease_claim');
    expect(migration).toContain("WHERE status = 'running'");
    expect(migration).toContain('idx_provider_sessions_agent_provider');
  });

  it('registers job tool access requirements cutover migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const cutover = journal.entries.find(
      (entry) => entry.tag === '0061_jobs_tool_access_requirements_cutover',
    );
    expect(cutover).toMatchObject({ idx: 61 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0061_jobs_tool_access_requirements_cutover.sql',
      ),
      'utf8',
    );
    expect(migration).toContain("target_json ? 'requiredTools'");
    expect(migration).toContain("target_json ? 'toolAccessRequirements'");
    expect(migration).toContain("target_json - 'requiredTools'");
    expect(migration).toContain("'{toolAccessRequirements}'");
  });

  it('registers live admission work-item migration and branch indexes', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const workItems = journal.entries.find(
      (entry) => entry.tag === '0080_live_admission_work_items',
    );
    expect(workItems).toMatchObject({ idx: 80 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0080_live_admission_work_items.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('"failure_count" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain(
      'CREATE INDEX "idx_live_admission_work_items_queued_fifo"',
    );
    expect(migration).toContain(
      'ON "live_admission_work_items" ("app_id", "created_at", "id")',
    );
    expect(migration).toContain(`WHERE "state" = 'queued'`);
    expect(migration).toContain(
      'CREATE INDEX "idx_live_admission_work_items_deferred_due"',
    );
    expect(migration).toContain(
      'ON "live_admission_work_items" ("app_id", "defer_until", "created_at", "id")',
    );
    expect(migration).toContain(`WHERE "state" = 'deferred'`);
    expect(migration).toContain('AND "defer_until" IS NOT NULL');
    expect(migration).toContain(
      'CREATE INDEX "idx_live_admission_work_items_claimed_expired"',
    );
    expect(migration).toContain(
      'CREATE INDEX "idx_live_admission_work_items_deferred_null_fifo"',
    );
    expect(migration).toContain('AND "defer_until" IS NULL');
    expect(migration).toContain(
      'ON "live_admission_work_items" ("app_id", "claim_expires_at", "created_at", "id")',
    );
    expect(migration).toContain(`WHERE "state" = 'claimed'`);
    expect(migration).toContain('AND "claim_expires_at" IS NOT NULL');

    const schema = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/live-turns.ts',
      ),
      'utf8',
    );
    expect(schema).toContain('idx_live_admission_work_items_queued_fifo');
    expect(schema).toContain('idx_live_admission_work_items_deferred_due');
    expect(schema).toContain(
      'idx_live_admission_work_items_deferred_null_fifo',
    );
    expect(schema).toContain('idx_live_admission_work_items_claimed_expired');
  });

  it('registers live turn recoverable sweep index migration and schema', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const recoverableIndexes = journal.entries.find(
      (entry) => entry.tag === '0082_live_turn_recoverable_sweep_indexes',
    );
    expect(recoverableIndexes).toMatchObject({ idx: 82 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0082_live_turn_recoverable_sweep_indexes.sql',
      ),
      'utf8',
    );
    expect(migration).toContain(
      'CREATE INDEX "idx_live_turns_recoverable_leased"',
    );
    expect(migration).toContain(
      'ON "live_turns" ("updated_at", "id", "run_id")',
    );
    expect(migration).toContain('"run_id" IS NOT NULL');
    expect(migration).toContain('"lease_token" IS NOT NULL');
    expect(migration).toContain('"fencing_version" IS NOT NULL');
    expect(migration).toContain(
      'CREATE INDEX "idx_live_turns_recoverable_unleased"',
    );
    expect(migration).toContain('ON "live_turns" ("updated_at", "id")');
    expect(migration).toContain('"lease_token" IS NULL');

    const schema = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/live-turns.ts',
      ),
      'utf8',
    );
    expect(schema).toContain('idx_live_turns_recoverable_leased');
    expect(schema).toContain('idx_live_turns_recoverable_unleased');
  });

  it('registers provider runtime secret ref object cutover migration', () => {
    const journalPath = path.resolve(
      'apps/core/src/adapters/storage/postgres/schema/migrations/meta/_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find(
      (item) => item.tag === '0088_provider_runtime_secret_ref_object',
    );
    expect(entry).toMatchObject({ idx: 88 });

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/0088_provider_runtime_secret_ref_object.sql',
      ),
      'utf8',
    );
    expect(migration).toContain(
      'ALTER COLUMN "runtime_secret_refs_json" SET DEFAULT',
    );
    expect(migration).toContain('jsonb_object_agg(ref_key, ref_value)');
    expect(migration).toContain(
      "WHEN \"provider_id\" = 'slack' AND ref_value ILIKE '%APP_TOKEN%' THEN 'app_token'",
    );
    expect(migration).toContain(
      'WHERE left(btrim("runtime_secret_refs_json"), 1) =',
    );
  });
});
