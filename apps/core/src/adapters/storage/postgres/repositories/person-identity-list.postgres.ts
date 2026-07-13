import { and, count, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  PersonAliasRecord,
  PersonListRepositoryInput,
  PersonListRepositoryPage,
  PersonRecord,
} from '../../../../application/identity/person-identity-service.js';
import * as pgSchema from '../schema/schema.js';
import {
  emptyMemoryCounts,
  toAlias,
  toPerson,
} from './person-identity-mappers.postgres.js';

type Db = NodePgDatabase<typeof pgSchema>;

export async function listPeoplePage(
  db: Db,
  appId: string,
  input: PersonListRepositoryInput,
): Promise<PersonListRepositoryPage> {
  const cursorPredicate = input.cursor
    ? or(
        lt(pgSchema.usersPostgres.updatedAt, input.cursor.updatedAt),
        and(
          eq(pgSchema.usersPostgres.updatedAt, input.cursor.updatedAt),
          lt(pgSchema.usersPostgres.id, input.cursor.personId),
        ),
      )
    : undefined;
  const rows = await db
    .select()
    .from(pgSchema.usersPostgres)
    .where(and(eq(pgSchema.usersPostgres.appId, appId), cursorPredicate))
    .orderBy(
      desc(pgSchema.usersPostgres.updatedAt),
      desc(pgSchema.usersPostgres.id),
    )
    .limit(input.limit + 1);
  const hasNextPage = rows.length > input.limit;
  const users = rows.slice(0, input.limit);
  if (users.length === 0) return { people: [], nextCursor: null };

  const personIds = users.map((user) => user.id);
  const aliases = (
    await db
      .select()
      .from(pgSchema.userAliasesPostgres)
      .where(
        and(
          eq(pgSchema.userAliasesPostgres.appId, appId),
          inArray(pgSchema.userAliasesPostgres.userId, personIds),
        ),
      )
      .orderBy(desc(pgSchema.userAliasesPostgres.updatedAt))
  ).map(toAlias);
  const aliasesByPerson = new Map<string, PersonAliasRecord[]>();
  for (const alias of aliases) {
    const personAliases = aliasesByPerson.get(alias.personId) ?? [];
    personAliases.push(alias);
    aliasesByPerson.set(alias.personId, personAliases);
  }

  const memoryRows = await db
    .select({
      personId: pgSchema.memoryItemsPostgres.userId,
      status: pgSchema.memoryItemsPostgres.status,
      count: count(),
    })
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.appId, appId),
        eq(pgSchema.memoryItemsPostgres.subjectType, 'user'),
        inArray(pgSchema.memoryItemsPostgres.userId, personIds),
      ),
    )
    .groupBy(
      pgSchema.memoryItemsPostgres.userId,
      pgSchema.memoryItemsPostgres.status,
    );
  const countsByPerson = new Map<
    string,
    NonNullable<PersonRecord['memoryCounts']>
  >();
  for (const row of memoryRows) {
    if (!row.personId) continue;
    const counts = countsByPerson.get(row.personId) ?? emptyMemoryCounts();
    const value = Number(row.count);
    counts.personal += value;
    if (row.status === 'active') counts.active += value;
    else if (row.status === 'archived') counts.archived += value;
    else if (row.status === 'superseded') counts.superseded += value;
    else if (row.status === 'deleted') counts.deleted += value;
    countsByPerson.set(row.personId, counts);
  }

  const last = users.at(-1)!;
  return {
    people: users.map((user) =>
      toPerson(user, aliasesByPerson.get(user.id), countsByPerson.get(user.id)),
    ),
    nextCursor: hasNextPage
      ? { updatedAt: last.updatedAt, personId: last.id }
      : null,
  };
}
