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
  // so two same-key source rows
  // with different (noncanonical) subject ids can coexist today — rekeying
  // canonicalizes both to one subject id and would trip the index mid-merge.
  // Surface those as conflicts up front instead of failing at the constraint.
  const self = alias(pgSchema.memoryItemsPostgres, 'self_memory');
  const collapses = await executor
    .select({
      agentId: self.agentId,
      kind: self.kind,
      key: self.key,
    })
    .from(self)
    .where(
      and(
        eq(self.appId, input.appId),
        eq(self.subjectType, 'user'),
        eq(self.userId, input.sourcePersonId),
        eq(self.status, 'active'),
      ),
    )
    .groupBy(self.agentId, self.kind, self.key)
    .having(sql`count(DISTINCT ${self.subjectId}) > 1`)
    .limit(PERSON_MERGE_DETAIL_LIMIT + 1);
  return [
    ...conflicts.map(
      (conflict) => ({ type: 'memory', ...conflict }) as PersonMergeConflict,
    ),
    ...collapses.map(
      (row) =>
        ({
          type: 'memory',
          agentId: row.agentId,
          kind: row.kind,
          key: `source-collapse:${row.key}`,
        }) as PersonMergeConflict,
    ),
  ];
}
