import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  PersonMergeConflict,
  PersonMergeInput,
} from '../../../../application/identity/person-identity-service.js';
import * as pgSchema from '../schema/schema.js';

type Db = NodePgDatabase<typeof pgSchema>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function findAliasMergeConflicts(
  executor: Executor,
  input: PersonMergeInput,
): Promise<PersonMergeConflict[]> {
  const sourceAliases = await executor
    .select()
    .from(pgSchema.userAliasesPostgres)
    .where(
      and(
        eq(pgSchema.userAliasesPostgres.appId, input.appId),
        eq(pgSchema.userAliasesPostgres.userId, input.sourcePersonId),
        isNull(pgSchema.userAliasesPostgres.retiredAt),
      ),
    );
  const conflicts: PersonMergeConflict[] = [];
  for (const source of sourceAliases) {
    const targetRows = await executor
      .select()
      .from(pgSchema.userAliasesPostgres)
      .where(
        and(
          eq(pgSchema.userAliasesPostgres.appId, input.appId),
          eq(pgSchema.userAliasesPostgres.userId, input.targetPersonId),
          eq(pgSchema.userAliasesPostgres.provider, source.provider),
          source.providerAccountId
            ? eq(
                pgSchema.userAliasesPostgres.providerAccountId,
                source.providerAccountId,
              )
            : isNull(pgSchema.userAliasesPostgres.providerAccountId),
          eq(
            pgSchema.userAliasesPostgres.externalUserId,
            source.externalUserId,
          ),
          isNull(pgSchema.userAliasesPostgres.retiredAt),
        ),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) continue;
    conflicts.push({
      type: 'alias',
      sourceAliasId: source.id,
      targetAliasId: target.id,
      kind: 'alias',
      key: [
        source.provider,
        source.providerAccountId ?? '',
        source.externalUserId,
      ].join(':'),
    });
  }
  return conflicts;
}
