import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  vector,
} from 'drizzle-orm/pg-core';

export * from './index.js';

export const storageMetaPostgres = pgTable('storage_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const routerStatePostgres = pgTable('router_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const memoryEvidencePostgres = pgTable(
  'memory_evidence',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    userId: text('user_id'),
    groupId: text('group_id'),
    channelId: text('channel_id'),
    threadId: text('thread_id'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    actorId: text('actor_id'),
    text: text('text').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    boundaryIdx: index('idx_memory_evidence_boundary').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
    searchIdx: index('idx_memory_evidence_search').using(
      'gin',
      sql`to_tsvector('english', ${table.text})`,
    ),
  }),
);

export const memoryCandidatesPostgres = pgTable(
  'memory_candidates',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    threadId: text('thread_id'),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    reason: text('reason'),
    evidenceIdsJson: text('evidence_ids_json').notNull().default('[]'),
    confidence: doublePrecision('confidence').notNull().default(0.5),
    status: text('status').notNull().default('staged'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    boundaryIdx: index('idx_memory_candidates_boundary').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.status,
      table.updatedAt,
    ),
  }),
);

export const memoryRecallEventsPostgres = pgTable(
  'memory_recall_events',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    itemId: text('item_id').notNull(),
    queryHash: text('query_hash').notNull(),
    score: doublePrecision('score').notNull(),
    subjectJson: text('subject_json').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    itemIdx: index('idx_memory_recall_events_item').on(
      table.itemId,
      table.createdAt,
    ),
    appIdx: index('idx_memory_recall_events_app').on(
      table.appId,
      table.agentId,
      table.createdAt,
    ),
  }),
);

export const memoryDreamRunsPostgres = pgTable(
  'memory_dream_runs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    phase: text('phase').notNull(),
    status: text('status').notNull(),
    summaryJson: text('summary_json').notNull().default('{}'),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    boundaryIdx: index('idx_memory_dream_runs_boundary').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.startedAt,
    ),
  }),
);

export const memoryDreamDecisionsPostgres = pgTable(
  'memory_dream_decisions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    itemId: text('item_id'),
    candidateId: text('candidate_id'),
    action: text('action').notNull(),
    rationale: text('rationale').notNull(),
    evidenceIdsJson: text('evidence_ids_json').notNull().default('[]'),
    applied: boolean('applied').notNull().default(false),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    runIdx: index('idx_memory_dream_decisions_run').on(table.runId),
    appIdx: index('idx_memory_dream_decisions_app').on(
      table.appId,
      table.agentId,
      table.createdAt,
    ),
  }),
);

export const embeddingCachePostgres = pgTable(
  'embedding_cache',
  {
    textHash: text('text_hash').notNull(),
    model: text('model').notNull(),
    embeddingJson: text('embedding_json').notNull(),
    embedding: vector('embedding', { dimensions: 3072 }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.textHash, table.model],
      name: 'embedding_cache_pk',
    }),
  }),
);
