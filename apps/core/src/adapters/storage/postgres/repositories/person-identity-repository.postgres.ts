import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
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
  type PersonMergeConflict,
  type PersonMergeInput,
  type PersonMergePreview,
  type PersonRecord,
  type RetirePersonAliasInput,
} from '../../../../application/identity/person-identity-service.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  auditToMergeApply,
  ensureApp,
  memoryCountsFromRows,
  normalizeProviderAccountId,
  personalMemorySubjectHash,
  retargetMemorySource,
  stableId,
  toAlias,
  toPerson,
} from './person-identity-mappers.postgres.js';
import { findAliasMergeConflicts } from './person-identity-merge-conflicts.postgres.js';

type Db = NodePgDatabase<typeof pgSchema>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
type UserRow = typeof pgSchema.usersPostgres.$inferSelect;
type AliasRow = typeof pgSchema.userAliasesPostgres.$inferSelect;
type MemoryRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;
type AuditRow = typeof pgSchema.personMergeAuditPostgres.$inferSelect;

export class PostgresPersonIdentityRepository implements PersonIdentityRepository {
  constructor(private readonly db: Db) {}

  async resolveIdentity(
    input: IdentityResolveInput,
  ): Promise<IdentityResolveResult> {
    const alias = await this.findAlias(this.db, input);
    if (alias) {
      const mapped = toAlias(alias);
      if (mapped.verificationStatus === 'retired') {
        throw new ApplicationError(
          'CONFLICT',
          'Alias is retired and cannot resolve active personal memory.',
        );
      }
      return {
        status: 'resolved',
        personId: mapped.personId,
        memoryHydrationEligible: true,
        matchedAlias: mapped,
        verificationStatus: mapped.verificationStatus,
      };
    }
    if (input.createIfMissing === false) {
      return {
        status: 'unresolved',
        personId: null,
        memoryHydrationEligible: false,
      };
    }
    return await this.db.transaction(async (tx) => {
      const existing = await this.findAlias(tx, input);
      if (existing) {
        const mapped = toAlias(existing);
        if (mapped.verificationStatus === 'retired') {
          throw new ApplicationError(
            'CONFLICT',
            'Alias is retired and cannot resolve active personal memory.',
          );
        }
        return {
          status: 'resolved' as const,
          personId: mapped.personId,
          memoryHydrationEligible: true,
          matchedAlias: mapped,
          verificationStatus: mapped.verificationStatus,
        };
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

  async listPeople(appId: string): Promise<PersonRecord[]> {
    const users = await this.db
      .select()
      .from(pgSchema.usersPostgres)
      .where(eq(pgSchema.usersPostgres.appId, appId))
      .orderBy(desc(pgSchema.usersPostgres.updatedAt));
    const result: PersonRecord[] = [];
    for (const user of users) {
      result.push(await this.hydratePerson(user));
    }
    return result;
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
      const duplicate = await this.findActiveAlias(tx, input);
      if (duplicate && duplicate.userId !== input.personId) {
        throw new ApplicationError(
          'CONFLICT',
          'Alias already belongs to another person.',
        );
      }
      if (duplicate) return toAlias(duplicate);
      return this.insertAlias(tx, {
        ...input,
        verificationStatus: 'verified',
        evidence: {
          ...(input.evidence || {}),
          evidenceType: input.evidenceType,
        },
        timestamp: nowIso(),
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
      const existingAudit = await this.findMergeAudit(
        tx,
        input.appId,
        idempotencyKey,
      );
      if (existingAudit) {
        const preview = await this.buildMergePreview(tx, input);
        return auditToMergeApply(existingAudit, preview, idempotencyKey, false);
      }
      await this.assertPeopleAccessible(
        tx,
        input.appId,
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
      const moved = await this.rekeyPersonalMemory(tx, {
        ...input,
        conflictResolution,
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
          createdAt: timestamp,
        })
        .returning();
      return auditToMergeApply(audit!, preview, idempotencyKey, true, moved);
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
          providerAccountId
            ? eq(
                pgSchema.userAliasesPostgres.providerAccountId,
                providerAccountId,
              )
            : isNull(pgSchema.userAliasesPostgres.providerAccountId),
          eq(pgSchema.userAliasesPostgres.externalUserId, input.externalUserId),
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
    const alias = await this.findAlias(executor, input);
    return alias && !alias.retiredAt ? alias : null;
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
    },
  ): Promise<PersonAliasRecord> {
    const providerAccountId = normalizeProviderAccountId(
      input.providerAccountId,
    );
    const aliasId = stableId('person-alias', [
      input.appId,
      input.provider,
      providerAccountId ?? '',
      input.externalUserId,
    ]);
    const [row] = await executor
      .insert(pgSchema.userAliasesPostgres)
      .values({
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
        verifiedBy:
          input.verificationStatus === 'verified' ? input.actor : null,
        evidenceJson: input.evidence || {},
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      })
      .onConflictDoUpdate({
        target: pgSchema.userAliasesPostgres.id,
        set: {
          userId: input.personId,
          displayName: input.displayName ?? input.externalUserId,
          verificationStatus: input.verificationStatus,
          verifiedAt:
            input.verificationStatus === 'verified' ? input.timestamp : null,
          verifiedBy:
            input.verificationStatus === 'verified' ? input.actor : null,
          retiredAt: null,
          retiredBy: null,
          evidenceJson: input.evidence || {},
          updatedAt: input.timestamp,
        },
      })
      .returning();
    return toAlias(row!);
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
      .limit(1);
    return rows[0] ?? null;
  }

  private async assertPeopleAccessible(
    executor: Executor,
    appId: string,
    targetPersonId: string,
    sourcePersonId: string,
  ): Promise<void> {
    if (targetPersonId === sourcePersonId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'sourcePersonId must differ from target personId',
      );
    }
    const rows = await executor
      .select()
      .from(pgSchema.usersPostgres)
      .where(
        and(
          eq(pgSchema.usersPostgres.appId, appId),
          inArray(pgSchema.usersPostgres.id, [targetPersonId, sourcePersonId]),
        ),
      );
    if (rows.length !== 2) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Person is not accessible to this app.',
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
    ).map(toAlias);
    const sourceRows = await executor
      .select()
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
    const conflicts = await this.findMemoryConflicts(
      executor,
      input,
      sourceRows,
    );
    conflicts.push(...(await findAliasMergeConflicts(executor, input)));
    return {
      summary: 'Merge preview only. No data changed.',
      sourcePersonId: input.sourcePersonId,
      targetPersonId: input.targetPersonId,
      aliasesToMove: aliases,
      memoryRowsToMove: sourceRows.length,
      excludedMemoryScopes: excluded,
      conflicts,
    };
  }

  private async findMemoryConflicts(
    executor: Executor,
    input: PersonMergeInput,
    sourceRows: MemoryRow[],
  ): Promise<PersonMergeConflict[]> {
    const conflicts: PersonMergeConflict[] = [];
    for (const source of sourceRows) {
      if (source.status !== 'active' || !source.agentId) continue;
      const targetRows = await executor
        .select()
        .from(pgSchema.memoryItemsPostgres)
        .where(
          and(
            eq(pgSchema.memoryItemsPostgres.appId, input.appId),
            eq(pgSchema.memoryItemsPostgres.agentId, source.agentId),
            eq(pgSchema.memoryItemsPostgres.subjectType, 'user'),
            eq(pgSchema.memoryItemsPostgres.userId, input.targetPersonId),
            eq(pgSchema.memoryItemsPostgres.status, 'active'),
            eq(pgSchema.memoryItemsPostgres.kind, source.kind),
            eq(pgSchema.memoryItemsPostgres.key, source.key),
          ),
        )
        .limit(1);
      if (targetRows[0]) {
        conflicts.push({
          type: 'memory',
          sourceMemoryId: source.id,
          targetMemoryId: targetRows[0].id,
          agentId: source.agentId,
          kind: source.kind,
          key: source.key,
        });
      }
    }
    return conflicts;
  }

  private async rekeyPersonalMemory(
    executor: Executor,
    input: PersonMergeInput & {
      conflictResolution: 'fail_on_conflict' | 'keep_target';
      timestamp: string;
    },
  ): Promise<number> {
    const sourceRows = await executor
      .select()
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, input.appId),
          eq(pgSchema.memoryItemsPostgres.subjectType, 'user'),
          eq(pgSchema.memoryItemsPostgres.userId, input.sourcePersonId),
        ),
      );
    let moved = 0;
    const conflicts = await this.findMemoryConflicts(
      executor,
      input,
      sourceRows,
    );
    const conflictIds = new Set(
      conflicts.map((conflict) => conflict.sourceMemoryId),
    );
    for (const row of sourceRows) {
      const isConflict = conflictIds.has(row.id);
      const nextStatus =
        isConflict && input.conflictResolution === 'keep_target'
          ? 'superseded'
          : row.status;
      await executor
        .update(pgSchema.memoryItemsPostgres)
        .set({
          subjectId: personalMemorySubjectHash({
            appId: row.appId,
            agentId: row.agentId,
            personId: input.targetPersonId,
          }),
          userId: input.targetPersonId,
          sourceRefJson: retargetMemorySource(row, input.targetPersonId),
          status: nextStatus,
          updatedAt: input.timestamp,
        })
        .where(eq(pgSchema.memoryItemsPostgres.id, row.id));
      moved += 1;
    }
    return moved;
  }

  private async findMergeAudit(
    executor: Executor,
    appId: string,
    idempotencyKey: string,
  ): Promise<AuditRow | null> {
    const rows = await executor
      .select()
      .from(pgSchema.personMergeAuditPostgres)
      .where(
        and(
          eq(pgSchema.personMergeAuditPostgres.appId, appId),
          eq(pgSchema.personMergeAuditPostgres.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
