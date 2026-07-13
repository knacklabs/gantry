import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
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
        eq(target.agentId, source.agentId),
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
        isNotNull(source.agentId),
      ),
    )
    .limit(PERSON_MERGE_DETAIL_LIMIT + 1);
  return conflicts.map((conflict) => ({ type: 'memory', ...conflict }));
}
