import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';

import {
  MEMORY_DREAM_RUN_TIMEOUT_MS,
  memoryDreamRunLeaseExpiresAt,
} from '../../../../shared/memory-dreaming-timeout.js';

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
    metadataJson: text('metadata_json').notNull().default('{}'),
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
      table.confidence,
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
    threadId: text('thread_id'),
    phase: text('phase').notNull(),
    status: text('status').notNull(),
    summaryJson: text('summary_json').notNull().default('{}'),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', {
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
    runningLightUniqueIdx: uniqueIndex(
      'idx_memory_dream_runs_running_light_unique',
    )
      .on(
        table.appId,
        table.agentId,
        table.subjectType,
        table.subjectId,
        sql`'light'::text`,
      )
      .where(
        sql`${table.status} = 'running' AND ${table.phase} IN ('all', 'light')`,
      ),
    runningRemUniqueIdx: uniqueIndex('idx_memory_dream_runs_running_rem_unique')
      .on(
        table.appId,
        table.agentId,
        table.subjectType,
        table.subjectId,
        sql`'rem'::text`,
      )
      .where(
        sql`${table.status} = 'running' AND ${table.phase} IN ('all', 'rem')`,
      ),
    runningDeepUniqueIdx: uniqueIndex(
      'idx_memory_dream_runs_running_deep_unique',
    )
      .on(
        table.appId,
        table.agentId,
        table.subjectType,
        table.subjectId,
        sql`'deep'::text`,
      )
      .where(
        sql`${table.status} = 'running' AND ${table.phase} IN ('all', 'deep')`,
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
    threadId: text('thread_id'),
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

export const memoryReviewRequestsPostgres = pgTable(
  'memory_review_requests',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    threadId: text('thread_id'),
    phase: text('phase').notNull(),
    proposalJson: text('proposal_json').notNull(),
    itemVersionsJson: text('item_versions_json').notNull().default('{}'),
    candidateVersionsJson: text('candidate_versions_json')
      .notNull()
      .default('{}'),
    status: text('status').notNull().default('pending_review'),
    validationSummary: text('validation_summary').notNull(),
    reviewerId: text('reviewer_id'),
    decision: text('decision'),
    editedValue: text('edited_value'),
    editedReason: text('edited_reason'),
    applyOutcome: text('apply_outcome'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    decidedAt: timestamp('decided_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    pendingBoundaryIdx: index('idx_memory_review_requests_pending_boundary').on(
      table.appId,
      table.agentId,
      table.subjectType,
      table.subjectId,
      table.status,
      table.createdAt,
    ),
    runIdx: index('idx_memory_review_requests_run').on(table.runId),
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

export const memoryItemEmbeddingsPostgres = pgTable(
  'memory_item_embeddings',
  {
    itemId: text('item_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    embeddingJson: text('embedding_json'),
    status: text('status').notNull().default('ready'),
    error: text('error'),
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
    pk: primaryKey({
      columns: [table.itemId, table.provider, table.model, table.contentHash],
      name: 'memory_item_embeddings_pk',
    }),
    itemIdx: index('idx_memory_item_embeddings_item').on(
      table.itemId,
      table.updatedAt,
    ),
    statusIdx: index('idx_memory_item_embeddings_status').on(
      table.status,
      table.updatedAt,
    ),
  }),
);

type DreamPhase = 'all' | 'light' | 'rem' | 'deep';
type DreamSubject = {
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
};

const CONCRETE_DREAM_PHASES = ['light', 'rem', 'deep'] as const;

export { MEMORY_DREAM_RUN_TIMEOUT_MS };

export function dreamRunLeaseExpiresAt(
  startedAt: string,
  deadlineAtMs?: number,
): string {
  return memoryDreamRunLeaseExpiresAt(startedAt, deadlineAtMs);
}

export function conflictingDreamPhases(phase: DreamPhase): DreamPhase[] {
  if (phase === 'all') return ['all', ...CONCRETE_DREAM_PHASES];
  return [phase, 'all'];
}

export async function findRunningDreamRun(input: {
  db: NodePgDatabase<any>;
  subject: DreamSubject;
  phase: DreamPhase;
  now: string;
}): Promise<typeof memoryDreamRunsPostgres.$inferSelect | null> {
  const { db, subject, phase, now } = input;
  const runs = await db
    .select()
    .from(memoryDreamRunsPostgres)
    .where(
      and(
        eq(memoryDreamRunsPostgres.appId, subject.appId),
        eq(memoryDreamRunsPostgres.agentId, subject.agentId),
        eq(memoryDreamRunsPostgres.subjectType, subject.subjectType),
        eq(memoryDreamRunsPostgres.subjectId, subject.subjectId),
        inArray(memoryDreamRunsPostgres.phase, conflictingDreamPhases(phase)),
        eq(memoryDreamRunsPostgres.status, 'running'),
        sql`${memoryDreamRunsPostgres.leaseExpiresAt} > ${now}`,
      ),
    )
    .orderBy(desc(memoryDreamRunsPostgres.startedAt))
    .limit(1);
  return runs[0] ?? null;
}

export async function expireStaleDreamRuns(input: {
  db: NodePgDatabase<any>;
  subject: DreamSubject;
  phase: DreamPhase;
  now: string;
}): Promise<void> {
  const { db, subject, phase, now } = input;
  await db
    .update(memoryDreamRunsPostgres)
    .set({
      status: 'failed',
      summaryJson: JSON.stringify({
        stage: 'stale_running_recovery',
        reason: 'dream run lease expired before acquisition',
        supersededByPhase: phase,
        leaseExpiredAt: now,
      }),
      completedAt: now,
    })
    .where(
      and(
        eq(memoryDreamRunsPostgres.appId, subject.appId),
        eq(memoryDreamRunsPostgres.agentId, subject.agentId),
        eq(memoryDreamRunsPostgres.subjectType, subject.subjectType),
        eq(memoryDreamRunsPostgres.subjectId, subject.subjectId),
        inArray(memoryDreamRunsPostgres.phase, conflictingDreamPhases(phase)),
        eq(memoryDreamRunsPostgres.status, 'running'),
        sql`${memoryDreamRunsPostgres.leaseExpiresAt} <= ${now}`,
      ),
    );
}
