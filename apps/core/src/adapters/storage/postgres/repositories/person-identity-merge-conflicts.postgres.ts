import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';

import type {
  PersonMergeConflict,
  PersonMergeInput,
} from '../../../../application/identity/person-identity-service.js';
import * as pgSchema from '../schema/schema.js';

type Db = NodePgDatabase<typeof pgSchema>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export const PERSON_MERGE_DETAIL_LIMIT = 1_000;

export async function findAliasMergeConflicts(
  executor: Executor,
  input: PersonMergeInput,
): Promise<PersonMergeConflict[]> {
  const source = alias(pgSchema.userAliasesPostgres, 'source_alias');
  const target = alias(pgSchema.userAliasesPostgres, 'target_alias');
  const conflicts = await executor
    .select({ sourceAliasId: source.id, targetAliasId: target.id })
    .from(source)
    .innerJoin(
      target,
      and(
        eq(target.appId, source.appId),
        eq(target.userId, input.targetPersonId),
        eq(target.provider, source.provider),
        sql`COALESCE(${target.providerAccountId}, '') = COALESCE(${source.providerAccountId}, '')`,
        eq(target.externalUserId, source.externalUserId),
        isNull(target.retiredAt),
      ),
    )
    .where(
      and(
        eq(source.appId, input.appId),
        eq(source.userId, input.sourcePersonId),
        isNull(source.retiredAt),
      ),
    )
    .limit(PERSON_MERGE_DETAIL_LIMIT + 1);
  return conflicts.map((conflict) => ({
    type: 'alias',
    sourceAliasId: conflict.sourceAliasId,
    targetAliasId: conflict.targetAliasId,
    kind: 'alias',
    key: `alias-conflict:${conflict.sourceAliasId}:${conflict.targetAliasId}`,
  }));
}

export async function findMemoryMergeConflicts(
  executor: Executor,
  input: PersonMergeInput,
): Promise<PersonMergeConflict[]> {
  const source = alias(pgSchema.memoryItemsPostgres, 'source_memory');
  const target = alias(pgSchema.memoryItemsPostgres, 'target_memory');
  const conflicts = await executor
    .select({
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      agentId: source.agentId,
      kind: source.kind,
      key: source.key,
    })
    .from(source)
    .innerJoin(
      target,
      and(
        eq(target.appId, source.appId),
        // NULL agent ids must still collide with each other: the unique index
        // treats NULLs as distinct, so an undetected pair would slip past
        // conflict review and duplicate an active key after the merge.
        sql`COALESCE(${target.agentId}, '') = COALESCE(${source.agentId}, '')`,
        eq(target.kind, source.kind),
        eq(target.key, source.key),
        eq(target.subjectType, 'user'),
        eq(target.userId, input.targetPersonId),
        eq(target.status, 'active'),
      ),
    )
    .where(
      and(
        eq(source.appId, input.appId),
        eq(source.subjectType, 'user'),
        eq(source.userId, input.sourcePersonId),
        eq(source.status, 'active'),
      ),
    )
    .limit(PERSON_MERGE_DETAIL_LIMIT + 1);
  // The active-unique key is (app, agent, subject_type, subject_id, kind, key),
  // so two same-key source rows with different (noncanonical) subject ids can
  // coexist today — rekeying canonicalizes both to one subject id and would
  // trip the index mid-merge. Surface every duplicate beyond the newest as a
  // conflict WITH its sourceMemoryId, so fail_on_conflict reports it and
  // keep_target supersedes it before the rekey.
  const ranked = await executor.execute<{
    id: string;
    agent_id: string | null;
    kind: string;
    key: string;
  }>(sql`
    SELECT id, agent_id, kind, key
    FROM (
      SELECT id, agent_id, kind, key,
             row_number() OVER (
               PARTITION BY COALESCE(agent_id, ''), kind, key
               ORDER BY updated_at DESC, id DESC
             ) AS rn
      FROM ${pgSchema.memoryItemsPostgres}
      WHERE app_id = ${input.appId}
        AND subject_type = 'user'
        AND user_id = ${input.sourcePersonId}
        AND status = 'active'
    ) d
    WHERE d.rn > 1
    LIMIT ${PERSON_MERGE_DETAIL_LIMIT + 1}
  `);
  const collapseRows =
    'rows' in ranked
      ? (ranked.rows as Array<{
          id: string;
          agent_id: string | null;
          kind: string;
          key: string;
        }>)
      : [];
  return [
    ...conflicts.map(
      (conflict) => ({ type: 'memory', ...conflict }) as PersonMergeConflict,
    ),
    ...collapseRows.map(
      (row) =>
        ({
          type: 'memory',
          sourceMemoryId: row.id,
          agentId: row.agent_id,
          kind: row.kind,
          key: `source-collapse:${row.key}`,
        }) as PersonMergeConflict,
    ),
  ];
}
