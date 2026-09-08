import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../schema/schema.js';
import { normalizeProviderAccountId } from './person-identity-mappers.postgres.js';

type Db = NodePgDatabase<typeof pgSchema>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
type AliasRow = typeof pgSchema.userAliasesPostgres.$inferSelect;

export interface ActiveIdentityAlias {
  alias: AliasRow;
  matchedPersonKind: 'human' | 'service';
}

export async function findActiveIdentityAlias(
  executor: Executor,
  input: {
    appId: string;
    provider: string;
    providerAccountId?: string | null;
    externalUserId: string;
  },
): Promise<ActiveIdentityAlias | null> {
  const providerAccountId = normalizeProviderAccountId(input.providerAccountId);
  const rows = await executor
    .select({
      alias: pgSchema.userAliasesPostgres,
      matchedPersonKind: pgSchema.usersPostgres.kind,
    })
    .from(pgSchema.userAliasesPostgres)
    .innerJoin(
      pgSchema.usersPostgres,
      and(
        eq(pgSchema.usersPostgres.appId, pgSchema.userAliasesPostgres.appId),
        eq(pgSchema.usersPostgres.id, pgSchema.userAliasesPostgres.userId),
      ),
    )
    .where(
      and(
        eq(pgSchema.userAliasesPostgres.appId, input.appId),
        eq(pgSchema.userAliasesPostgres.provider, input.provider),
        sql`COALESCE(${pgSchema.userAliasesPostgres.providerAccountId}, '') = ${providerAccountId ?? ''}`,
        eq(pgSchema.userAliasesPostgres.externalUserId, input.externalUserId),
        isNull(pgSchema.userAliasesPostgres.retiredAt),
      ),
    )
    .orderBy(desc(pgSchema.userAliasesPostgres.updatedAt))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        alias: row.alias,
        matchedPersonKind: row.matchedPersonKind as 'human' | 'service',
      }
    : null;
}
