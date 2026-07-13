import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { ApplicationError } from '../../../../application/common/application-error.js';
import {
  type AddPersonAliasInput,
  type AliasVerificationStatus,
  type IdentityResolveInput,
  type IdentityResolveResult,
  type PersonAliasRecord,
  type PersonIdentityRepository,
  type PersonMergeApplyResult,
  type PersonMergeInput,
  type PersonMergePreview,
  type PersonRecord,
  type PersonListRepositoryInput,
  type PersonListRepositoryPage,
  type RetirePersonAliasInput,
} from '../../../../application/identity/person-identity-service.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  auditToMergeApply,
  assertMergeAuditMatches,
  ensureApp,
  findMergeAudit,
  lockPersonAliasKey,
  memoryCountsFromRows,
  normalizeProviderAccountId,
  rekeyPersonalMemory,
  stableId,
  toAlias,
  toPerson,
} from './person-identity-mappers.postgres.js';
import { listPeoplePage } from './person-identity-list.postgres.js';
import {
  findAliasMergeConflicts,
  findMemoryMergeConflicts,
  PERSON_MERGE_DETAIL_LIMIT,
} from './person-identity-merge-conflicts.postgres.js';

type Db = NodePgDatabase<typeof pgSchema>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
type UserRow = typeof pgSchema.usersPostgres.$inferSelect;
type AliasRow = typeof pgSchema.userAliasesPostgres.$inferSelect;

export class PostgresPersonIdentityRepository implements PersonIdentityRepository {
  constructor(private readonly db: Db) {}

  async resolveIdentity(
    input: IdentityResolveInput,
  ): Promise<IdentityResolveResult> {
    const alias = await this.findActiveAlias(this.db, input);
    if (alias) {
      const mapped = toAlias(alias);
      return {
        status: 'resolved',
        personId: mapped.personId,
        memoryHydrationEligible: true,
        matchedAlias: mapped,
        verificationStatus: mapped.verificationStatus,
      };
    }
    if (await this.findRetiredAlias(this.db, input)) {
      throw new ApplicationError(
        'CONFLICT',
        'Alias is retired and cannot resolve active personal memory.',
      );
    }
    if (input.createIfMissing === false) {
      return {
        status: 'unresolved',
        personId: null,
        memoryHydrationEligible: false,
      };
    }
    return await this.db.transaction(async (tx) => {
      await lockPersonAliasKey(tx, input);
      const existing = await this.findActiveAlias(tx, input);
      if (existing) {
        const mapped = toAlias(existing);
        return {
          status: 'resolved' as const,
          personId: mapped.personId,
          memoryHydrationEligible: true,
          matchedAlias: mapped,
          verificationStatus: mapped.verificationStatus,
        };
      }
      if (await this.findRetiredAlias(tx, input)) {
        throw new ApplicationError(
          'CONFLICT',
          'Alias is retired and cannot resolve active personal memory.',
        );
      }
      await ensureApp(tx, input.appId);
      const timestamp = nowIso();
      const personId = stableId('person', [
        input.appId,
        input.provider,
        normalizeProviderAccountId(input.providerAccountId) ?? '',
        input.externalUserId,
      ]);
      await tx
        .insert(pgSchema.usersPostgres)
        .values({
          id: personId,
          appId: input.appId,
          kind: 'human',
          displayName: input.displayName ?? input.externalUserId,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing();
      const alias = await this.insertAlias(tx, {
        appId: input.appId,
        personId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        externalUserId: input.externalUserId,
        displayName: input.displayName,
        verificationStatus: 'unverified',
        evidence: { evidenceType: input.evidenceType },
        actor: 'identity:resolve',
        timestamp,
      });
      return {
        status: 'created',
        personId,
        memoryHydrationEligible: true,
        createdAlias: alias,
        verificationStatus: alias.verificationStatus,
      };
    });
  }

  async listPeople(
    appId: string,
    input: PersonListRepositoryInput,
  ): Promise<PersonListRepositoryPage> {
    return listPeoplePage(this.db, appId, input);
  }

  async getPerson(
    appId: string,
    personId: string,
  ): Promise<PersonRecord | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.usersPostgres)
      .where(
        and(
          eq(pgSchema.usersPostgres.appId, appId),
          eq(pgSchema.usersPostgres.id, personId),
        ),
      )
      .limit(1);
    return rows[0] ? this.hydratePerson(rows[0]) : null;
  }

  async addAlias(input: AddPersonAliasInput): Promise<PersonAliasRecord> {
    return await this.db.transaction(async (tx) => {
      const person = await this.getPersonForUpdate(
        tx,
        input.appId,
        input.personId,
      );
      if (!person) {
        throw new ApplicationError(
          'FORBIDDEN',
          'Person is not accessible to this app.',
        );
      }
      if (person.status !== 'active') {
        throw new ApplicationError(
          'CONFLICT',
          'Aliases cannot be added to an inactive person.',
        );
      }
      await lockPersonAliasKey(tx, input);
      const duplicate = await this.findActiveAlias(tx, input);
      if (duplicate && duplicate.userId !== input.personId) {
        throw new ApplicationError(
          'CONFLICT',
          'Alias already belongs to another person.',
        );
      }
      const verifiedAlias = {
        ...input,
        verificationStatus: 'verified' as const,
        evidence: {
          ...(input.evidence || {}),
          evidenceType: input.evidenceType,
        },
        timestamp: nowIso(),
      };
      if (duplicate) {
        return duplicate.verificationStatus === 'verified'
          ? toAlias(duplicate)
          : this.insertAlias(tx, { ...verifiedAlias, aliasId: duplicate.id });
      }
      const retired = await this.findRetiredAlias(tx, input);
      if (retired && retired.userId !== input.personId) {
        throw new ApplicationError(
          'CONFLICT',
          'Retired alias belongs to another person and cannot be rebound.',
        );
      }
      return this.insertAlias(tx, {
        ...verifiedAlias,
        aliasId: retired?.id,
      });
    });
  }

  async retireAlias(
    input: RetirePersonAliasInput,
  ): Promise<PersonAliasRecord | null> {
    const timestamp = nowIso();
    const [row] = await this.db
      .update(pgSchema.userAliasesPostgres)
      .set({
        verificationStatus: 'retired',
        retiredAt: timestamp,
        retiredBy: input.actor,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(pgSchema.userAliasesPostgres.appId, input.appId),
          eq(pgSchema.userAliasesPostgres.userId, input.personId),
          eq(pgSchema.userAliasesPostgres.id, input.aliasId),
        ),
      )
      .returning();
    return row ? toAlias(row) : null;
  }

  async previewMerge(input: PersonMergeInput): Promise<PersonMergePreview> {
    await this.assertPeopleAccessible(
      this.db,
      input.appId,
      input.targetPersonId,
      input.sourcePersonId,
    );
    return this.buildMergePreview(this.db, input);
  }

  async mergePeople(input: PersonMergeInput): Promise<PersonMergeApplyResult> {
    const conflictResolution = input.conflictResolution ?? 'fail_on_conflict';
    const idempotencyKey =
      input.idempotencyKey ||
      stableId('person-merge', [
        input.appId,
        input.sourcePersonId,
        input.targetPersonId,
        conflictResolution,
      ]);
    return await this.db.transaction(async (tx) => {
      const idempotencyLockKey = JSON.stringify([
        'person-merge',
        input.appId,
        idempotencyKey,
      ]);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyLockKey}, 0))`,
      );
      const existingAudit = await findMergeAudit(
        tx,
        input.appId,
        idempotencyKey,
      );
      if (existingAudit) {
        assertMergeAuditMatches(existingAudit, input, conflictResolution);
        return auditToMergeApply(existingAudit, idempotencyKey, false);
      }
      const people = await this.lockPeopleForMerge(
        tx,
        input.appId,
        input.targetPersonId,
        input.sourcePersonId,
      );
      this.assertPeopleMergeable(
        people,
        input.targetPersonId,
        input.sourcePersonId,
      );
      const preview = await this.buildMergePreview(tx, input);
      const aliasConflicts = preview.conflicts.filter(
        (conflict) => conflict.type === 'alias',
      );
      if (aliasConflicts.length > 0) {
        throw new ApplicationError(
          'CONFLICT',
          'Merge has alias conflicts. Resolve aliases before applying the merge.',
        );
      }
      if (
        preview.conflicts.length > 0 &&
        conflictResolution === 'fail_on_conflict'
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Merge has personal memory conflicts. Run preview and choose a conflictResolution.',
        );
      }
      const timestamp = nowIso();
      await tx
        .update(pgSchema.userAliasesPostgres)
        .set({ userId: input.targetPersonId, updatedAt: timestamp })
        .where(
          and(
            eq(pgSchema.userAliasesPostgres.appId, input.appId),
            eq(pgSchema.userAliasesPostgres.userId, input.sourcePersonId),
          ),
        );
      const moved = await rekeyPersonalMemory(tx, {
        ...input,
        conflictResolution,
        conflictSourceIds: preview.conflicts.flatMap((conflict) =>
          conflict.type === 'memory' && conflict.sourceMemoryId
            ? [conflict.sourceMemoryId]
            : [],
        ),
        timestamp,
      });
      await tx
        .update(pgSchema.usersPostgres)
        .set({ status: 'archived', updatedAt: timestamp })
        .where(
          and(
            eq(pgSchema.usersPostgres.appId, input.appId),
            eq(pgSchema.usersPostgres.id, input.sourcePersonId),
          ),
        );
      const auditId = `person-merge:${randomUUID()}`;
      const [audit] = await tx
        .insert(pgSchema.personMergeAuditPostgres)
        .values({
          id: auditId,
          appId: input.appId,
          idempotencyKey,
          sourcePersonId: input.sourcePersonId,
          targetPersonId: input.targetPersonId,
          actor: input.actor,
          conflictResolution,
          aliasesMoved: preview.aliasesToMove.length,
          memoryRowsMoved: moved,
          conflictsJson: preview.conflicts,
          resultJson: {
            aliasesToMove: preview.aliasesToMove,
            excludedMemoryScopes: preview.excludedMemoryScopes,
          },
          createdAt: timestamp,
        })
        .returning();
      return auditToMergeApply(audit!, idempotencyKey, true);
    });
  }

  private async hydratePerson(user: UserRow): Promise<PersonRecord> {
    const aliases = (
      await this.db
        .select()
        .from(pgSchema.userAliasesPostgres)
        .where(eq(pgSchema.userAliasesPostgres.userId, user.id))
        .orderBy(desc(pgSchema.userAliasesPostgres.updatedAt))
    ).map(toAlias);
    const counts = await this.memoryCounts(user.appId, user.id);
    return toPerson(user, aliases, counts);
  }

  private async memoryCounts(
    appId: string,
    personId: string,
  ): Promise<NonNullable<PersonRecord['memoryCounts']>> {
    const rows = await this.db
      .select({
        status: pgSchema.memoryItemsPostgres.status,
        count: count(),
      })
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, appId),
          eq(pgSchema.memoryItemsPostgres.subjectType, 'user'),
          eq(pgSchema.memoryItemsPostgres.userId, personId),
        ),
      )
      .groupBy(pgSchema.memoryItemsPostgres.status);
    return memoryCountsFromRows(rows);
  }

  private async findAlias(
    executor: Executor,
    input: {
      appId: string;
      provider: string;
      providerAccountId?: string | null;
      externalUserId: string;
    },
    active: boolean,
  ): Promise<AliasRow | null> {
    const providerAccountId = normalizeProviderAccountId(
      input.providerAccountId,
    );
    const rows = await executor
      .select()
      .from(pgSchema.userAliasesPostgres)
      .where(
        and(
          eq(pgSchema.userAliasesPostgres.appId, input.appId),
          eq(pgSchema.userAliasesPostgres.provider, input.provider),
          sql`COALESCE(${pgSchema.userAliasesPostgres.providerAccountId}, '') = ${providerAccountId ?? ''}`,
          eq(pgSchema.userAliasesPostgres.externalUserId, input.externalUserId),
          active
            ? isNull(pgSchema.userAliasesPostgres.retiredAt)
            : isNotNull(pgSchema.userAliasesPostgres.retiredAt),
        ),
      )
      .orderBy(desc(pgSchema.userAliasesPostgres.updatedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private async findActiveAlias(
    executor: Executor,
    input: {
      appId: string;
      provider: string;
      providerAccountId?: string | null;
      externalUserId: string;
    },
  ): Promise<AliasRow | null> {
    return this.findAlias(executor, input, true);
  }

  private async findRetiredAlias(
    executor: Executor,
    input: {
      appId: string;
      provider: string;
      providerAccountId?: string | null;
      externalUserId: string;
    },
  ): Promise<AliasRow | null> {
    return this.findAlias(executor, input, false);
  }

  private async insertAlias(
    executor: Executor,
    input: {
      appId: string;
      personId: string;
      provider: string;
      providerAccountId?: string | null;
      externalUserId: string;
      displayName?: string | null;
      evidence?: Record<string, unknown>;
      actor: string;
      verificationStatus: Exclude<AliasVerificationStatus, 'retired'>;
      timestamp: string;
      aliasId?: string;
    },
  ): Promise<PersonAliasRecord> {
    const providerAccountId = normalizeProviderAccountId(
      input.providerAccountId,
    );
    const aliasId =
      input.aliasId ??
      stableId('person-alias', [
        input.appId,
        input.provider,
        providerAccountId ?? '',
        input.externalUserId,
      ]);
    const values = {
      id: aliasId,
      appId: input.appId,
      userId: input.personId,
      provider: input.provider,
      providerAccountId,
      externalUserId: input.externalUserId,
      displayName: input.displayName ?? input.externalUserId,
      verificationStatus: input.verificationStatus,
      verifiedAt:
        input.verificationStatus === 'verified' ? input.timestamp : null,
      verifiedBy: input.verificationStatus === 'verified' ? input.actor : null,
      evidenceJson: input.evidence || {},
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
    const [inserted] = await executor
      .insert(pgSchema.userAliasesPostgres)
      .values(values)
      .onConflictDoNothing()
      .returning();
    if (inserted) return toAlias(inserted);
    const [owned] = await executor
      .update(pgSchema.userAliasesPostgres)
      .set({
        displayName: values.displayName,
        verificationStatus: values.verificationStatus,
        verifiedAt: values.verifiedAt,
        verifiedBy: values.verifiedBy,
        retiredAt: null,
        retiredBy: null,
        evidenceJson: values.evidenceJson,
        updatedAt: values.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.userAliasesPostgres.id, aliasId),
          eq(pgSchema.userAliasesPostgres.appId, input.appId),
          eq(pgSchema.userAliasesPostgres.userId, input.personId),
        ),
      )
      .returning();
    if (owned) return toAlias(owned);
    const active = await this.findActiveAlias(executor, input);
    if (active?.userId === input.personId) return toAlias(active);
    throw new ApplicationError(
      'CONFLICT',
      'Alias already belongs to another person.',
    );
  }

  private async getPersonForUpdate(
    executor: Executor,
    appId: string,
    personId: string,
  ): Promise<UserRow | null> {
    const rows = await executor
      .select()
      .from(pgSchema.usersPostgres)
      .where(
        and(
          eq(pgSchema.usersPostgres.appId, appId),
          eq(pgSchema.usersPostgres.id, personId),
        ),
      )
      .for('update')
      .limit(1);
    return rows[0] ?? null;
  }

  private async assertPeopleAccessible(
    executor: Executor,
    appId: string,
    targetPersonId: string,
    sourcePersonId: string,
  ): Promise<void> {
    const rows = await executor
      .select()
      .from(pgSchema.usersPostgres)
      .where(
        and(
          eq(pgSchema.usersPostgres.appId, appId),
          inArray(pgSchema.usersPostgres.id, [targetPersonId, sourcePersonId]),
        ),
      );
    this.assertPeopleMergeable(rows, targetPersonId, sourcePersonId);
  }

  private async lockPeopleForMerge(
    executor: Executor,
    appId: string,
    targetPersonId: string,
    sourcePersonId: string,
  ): Promise<UserRow[]> {
    return executor
      .select()
      .from(pgSchema.usersPostgres)
      .where(
        and(
          eq(pgSchema.usersPostgres.appId, appId),
          inArray(pgSchema.usersPostgres.id, [targetPersonId, sourcePersonId]),
        ),
      )
      .orderBy(asc(pgSchema.usersPostgres.id))
      .for('update');
  }

  private assertPeopleMergeable(
    rows: UserRow[],
    targetPersonId: string,
    sourcePersonId: string,
  ): void {
    if (targetPersonId === sourcePersonId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'sourcePersonId must differ from target personId',
      );
    }
    if (rows.length !== 2) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Person is not accessible to this app.',
      );
    }
    if (rows.some((row) => row.status !== 'active')) {
      throw new ApplicationError(
        'CONFLICT',
        'Source and target people must both be active and unmerged.',
      );
    }
  }

  private async buildMergePreview(
    executor: Executor,
    input: PersonMergeInput,
  ): Promise<PersonMergePreview> {
    const aliases = (
      await executor
        .select()
        .from(pgSchema.userAliasesPostgres)
        .where(
          and(
            eq(pgSchema.userAliasesPostgres.appId, input.appId),
            eq(pgSchema.userAliasesPostgres.userId, input.sourcePersonId),
          ),
        )
        .limit(PERSON_MERGE_DETAIL_LIMIT + 1)
    ).map(toAlias);
    if (aliases.length > PERSON_MERGE_DETAIL_LIMIT) {
      throw new ApplicationError(
        'CONFLICT',
        `Person merge exceeds the ${PERSON_MERGE_DETAIL_LIMIT} alias detail limit.`,
      );
    }
    const [sourceMemoryCount] = await executor
      .select({ count: count() })
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, input.appId),
          eq(pgSchema.memoryItemsPostgres.subjectType, 'user'),
          eq(pgSchema.memoryItemsPostgres.userId, input.sourcePersonId),
        ),
      );
    const excludedRows = await executor
      .select({
        subjectType: pgSchema.memoryItemsPostgres.subjectType,
        count: count(),
      })
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, input.appId),
          ne(pgSchema.memoryItemsPostgres.subjectType, 'user'),
          eq(pgSchema.memoryItemsPostgres.userId, input.sourcePersonId),
        ),
      )
      .groupBy(pgSchema.memoryItemsPostgres.subjectType);
    const excluded = { group: 0, channel: 0, common: 0 };
    for (const row of excludedRows) {
      if (row.subjectType === 'group') excluded.group = Number(row.count);
      else if (row.subjectType === 'channel')
        excluded.channel = Number(row.count);
      else if (row.subjectType === 'common')
        excluded.common = Number(row.count);
    }
    const conflicts = await findMemoryMergeConflicts(executor, input);
    conflicts.push(...(await findAliasMergeConflicts(executor, input)));
    if (conflicts.length > PERSON_MERGE_DETAIL_LIMIT) {
      throw new ApplicationError(
        'CONFLICT',
        `Person merge exceeds the ${PERSON_MERGE_DETAIL_LIMIT} conflict detail limit.`,
      );
    }
    return {
      summary: 'Merge preview only. No data changed.',
      sourcePersonId: input.sourcePersonId,
      targetPersonId: input.targetPersonId,
      aliasesToMove: aliases,
      memoryRowsToMove: Number(sourceMemoryCount?.count ?? 0),
      excludedMemoryScopes: excluded,
      conflicts,
    };
  }
}
