import fs from 'node:fs';
import path from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(
  'apps/core/src/adapters/storage/postgres/schema/migrations',
);
const baselineSql = fs.readFileSync(
  path.join(migrationsDir, '0000_ponytail_baseline.sql'),
  'utf8',
);
const snapshot = JSON.parse(
  fs.readFileSync(path.join(migrationsDir, 'meta/0000_snapshot.json'), 'utf8'),
) as {
  tables: Record<
    string,
    {
      columns: Record<string, { type?: string }>;
      indexes: Record<string, unknown>;
      checkConstraints: Record<string, unknown>;
    }
  >;
};

describe('Postgres migration baseline', () => {
  it('pins the only migration to the Phase 7 stamp', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf8'),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };

    expect(journal.entries).toEqual([
      {
        idx: 0,
        version: '7',
        when: 1784609882223,
        tag: '0000_ponytail_baseline',
        breakpoints: true,
      },
    ]);
    expect(
      fs
        .readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .sort(),
    ).toEqual(['0000_ponytail_baseline.sql']);

    const migrations = readMigrationFiles({ migrationsFolder: migrationsDir });
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      folderMillis: 1784609882223,
      hash: '406a5a9af01f7aa922a8a2df716019f85a742577e0163e2d1e131c93544872ea',
      bps: true,
    });
  });

  it('captures the current schema in the snapshot', () => {
    expect(Object.keys(snapshot.tables)).toHaveLength(93);
    expect(snapshot.tables['public.settings_revisions']).toBeDefined();
    expect(
      snapshot.tables['public.conversations']?.columns.requires_trigger,
    ).toBeDefined();
    expect(
      snapshot.tables['public.conversation_installs']?.columns,
    ).not.toHaveProperty('trigger');
    expect(
      snapshot.tables['public.conversation_installs']?.columns,
    ).not.toHaveProperty('requires_trigger');
    expect(
      snapshot.tables['public.conversation_installs']?.columns,
    ).not.toHaveProperty('sender_policy');
    expect(
      snapshot.tables['public.conversation_installs']?.columns,
    ).not.toHaveProperty('control_policy');
    expect(snapshot.tables['public.permission_prompts']?.columns).toMatchObject(
      {
        canonical_batch_id: expect.any(Object),
        rendered_request_json: expect.any(Object),
        rendered_decision_options_json: expect.any(Object),
        full_view_json: expect.any(Object),
        settlement_state: expect.any(Object),
        decision_policy: expect.any(Object),
      },
    );
    expect(
      snapshot.tables['public.pending_interactions']?.columns,
    ).toMatchObject({
      envelope_id: expect.any(Object),
      member_index: expect.any(Object),
      source_agent_folder: expect.any(Object),
      request_id: expect.any(Object),
      run_lease_token: expect.any(Object),
      run_lease_fencing_version: expect.any(Object),
    });
    expect(
      snapshot.tables['public.memory_item_embeddings']?.columns.embedding,
    ).toMatchObject({ type: 'vector(1536)' });
    for (const [table, collection, name] of [
      [
        'public.event_bus_outbox',
        'checkConstraints',
        'event_bus_outbox_event_version_check',
      ],
      [
        'public.event_bus_outbox',
        'checkConstraints',
        'event_bus_outbox_status_check',
      ],
      [
        'public.event_bus_outbox',
        'checkConstraints',
        'event_bus_outbox_attempt_count_check',
      ],
      [
        'public.agent_runs',
        'checkConstraints',
        'agent_runs_execution_provider_id_safe',
      ],
      [
        'public.llm_profiles',
        'checkConstraints',
        'llm_profiles_response_family_valid',
      ],
      [
        'public.control_http_webhooks',
        'checkConstraints',
        'control_http_webhooks_event_types_nonempty_check',
      ],
      [
        'public.control_http_webhooks',
        'checkConstraints',
        'control_http_webhooks_subject_requires_events_check',
      ],
      [
        'public.agent_sessions',
        'indexes',
        'idx_agent_sessions_deterministic_key',
      ],
      [
        'public.agent_sessions',
        'indexes',
        'idx_agent_sessions_app_scope_key_prefix',
      ],
      ['public.agent_runs', 'indexes', 'idx_agent_runs_session_created'],
      ['public.messages', 'indexes', 'idx_messages_delivery_status'],
      [
        'public.conversation_installs',
        'indexes',
        'idx_conversation_installs_agent_conversation',
      ],
    ] as const) {
      expect(snapshot.tables[table]?.[collection]).not.toHaveProperty(name);
    }
  });

  it('keeps the fresh baseline create-only and schema-neutral', () => {
    expect(baselineSql).toContain('CREATE TABLE "settings_revisions"');
    expect(baselineSql).toContain('CREATE TABLE "permission_prompts"');
    expect(baselineSql).toContain(
      'CREATE INDEX "idx_memory_item_embeddings_hnsw" ON "memory_item_embeddings" USING hnsw ("embedding" vector_cosine_ops)',
    );
    for (const phase of ['light', 'rem', 'deep']) {
      expect(baselineSql).toContain(`"subject_id",('${phase}'::text))`);
    }
    for (const constraint of [
      'event_bus_outbox_event_version_check',
      'event_bus_outbox_status_check',
      'event_bus_outbox_attempt_count_check',
      'agent_runs_execution_provider_id_safe',
      'llm_profiles_response_family_valid',
      'control_http_webhooks_event_types_nonempty_check',
      'control_http_webhooks_subject_requires_events_check',
    ]) {
      expect(baselineSql).toContain(`CONSTRAINT "${constraint}"`);
    }
    for (const index of [
      'idx_agent_sessions_deterministic_key',
      'idx_agent_sessions_app_scope_key_prefix',
      'idx_agent_runs_session_created',
      'idx_messages_delivery_status',
      'idx_conversation_installs_agent_conversation',
    ]) {
      expect(baselineSql).toContain(`INDEX "${index}"`);
    }
    expect(baselineSql).toContain(
      `"execution_provider_id" !~ '^unconfigured:'`,
    );
    expect(baselineSql).toContain(`"scope_key" text_pattern_ops`);
    expect(baselineSql).not.toContain('"public".');

    const [migration] = readMigrationFiles({
      migrationsFolder: migrationsDir,
    });
    expect(
      migration?.sql
        .map((statement) => statement.trim())
        .filter((statement) => /^(UPDATE|DELETE|DROP)\b/i.test(statement)),
    ).toEqual([]);
  });
});
