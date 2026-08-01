import { randomUUID } from 'node:crypto';

import { ApplicationError } from '../../../../application/common/application-error.js';
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

import {
  type AddPersonAliasInput,
  type IdentityResolveInput,
  type IdentityResolveResult,
  type PersonAliasRecord,
  type PersonIdentityRepository,
  type PersonMergeApplyResult,
  type PersonMergeInput,
  type PersonMergePreview,
  type PersonUnmergeInput,
  type PersonUnmergeResult,
  type PersonRecord,
  type PersonListRepositoryInput,
  type PersonListRepositoryPage,
  type RetirePersonAliasInput,
  personMergeFingerprint,
} from '../../../../application/identity/person-identity-service.js';
import type { RuntimeEventPublishInput } from '../../../../domain/events/events.js';
import {
  assertAliasCanResolve,
  assertAliasOwnership,
  assertAliasTargetIsActive,
  assertDetailLimit,
  assertMergeConflicts,
  assertMergeablePeople,
  assertRetiredAliasCanBeRebound,
} from '../../../../application/identity/person-identity-policy.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import { stableSha256Json } from '../../../../shared/stable-hash.js';
import * as pgSchema from '../schema/schema.js';
import {
  auditToMergeApply,
  assertMergeAuditMatches,
  ensureApp,
  findMergeAudit,
  findMergeAuditByIdForUpdate,
  lockPersonAliasKey,
  mergeUndoSnapshot,
  memoryCountsFromRows,
  normalizeProviderAccountId,
  rekeyPersonalMemory,
  restorePersonalMemory,
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
import { PostgresRuntimeEventRepository } from './runtime-event-repository.postgres.js';

type Db = NodePgDatabase<typeof pgSchema>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
type UserRow = typeof pgSchema.usersPostgres.$inferSelect;
type AliasRow = typeof pgSchema.userAliasesPostgres.$inferSelect;

export class PostgresPersonIdentityRepository implements PersonIdentityRepository {
  constructor(
    private readonly db: Db,
    private readonly runtimeEvents = new PostgresRuntimeEventRepository(db),
  ) {}

  async resolveIdentity(
    input: IdentityResolveInput,
    auditEventFactory?: (
      result: IdentityResolveResult,
    ) => RuntimeEventPublishInput,
  ): Promise<IdentityResolveResult> {
    const alias = await this.findActiveAlias(this.db, input);
    if (alias) {
      const mapped = toAlias(alias);
      const result: IdentityResolveResult = {
        status: 'resolved',
        personId: mapped.personId,
        memoryHydrationEligible: true,
        matchedAlias: mapped,
        verificationStatus: mapped.verificationStatus,
      };
      return auditEventFactory
        ? this.db.transaction((tx) =>
            this.appendResolutionAudit(tx, result, auditEventFactory),
          )
        : result;
    }
    if (await this.findRetiredAlias(this.db, input)) {
      assertAliasCanResolve(true);
    }
    if (input.createIfMissing === false) {
      const result: IdentityResolveResult = {
        status: 'unresolved',
        personId: null,
        memoryHydrationEligible: false,
      };
      return auditEventFactory
        ? this.db.transaction((tx) =>
            this.appendResolutionAudit(tx, result, auditEventFactory),
          )
        : result;
    }
    return await this.db.transaction(async (tx) => {
      await lockPersonAliasKey(tx, input);
      const existing = await this.findActiveAlias(tx, input);
      if (existing) {
        const mapped = toAlias(existing);
        const result = {
          status: 'resolved' as const,
          personId: mapped.personId,
          memoryHydrationEligible: true,
          matchedAlias: mapped,
          verificationStatus: mapped.verificationStatus,
        };
        if (auditEventFactory) {
          await this.runtimeEvents.appendRuntimeEventWithExecutor(
            tx,
            auditEventFactory(result),
          );
        }
        return result;
      }
      if (await this.findRetiredAlias(tx, input)) {
        assertAliasCanResolve(true);
      }
      await ensureApp(tx, input.appId);
      const timestamp = nowIso();
      const personId = stableId('person', [
        input.appId,
        input.provider,
        normalizeProviderAccountId(input.providerAccountId) ?? '',
        input.externalUserId,
      ]);
      await this.createPerson(tx, {
        personId,
        appId: input.appId,
        kind: 'human',
        displayName: input.displayName ?? input.externalUserId,
        timestamp,
      });
      const alias = await this.insertAlias(tx, {
        appId: input.appId,
        personId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        externalUserId: input.externalUserId,
        displayName: input.displayName,
        verificationStatus: 'unverified',
        evidence: { evidenceType: input.evidenceType },
        timestamp,
      });
      const result: IdentityResolveResult = {
        status: 'created',
        personId,
        memoryHydrationEligible: true,
        createdAlias: alias,
        verificationStatus: alias.verificationStatus,
      };
      if (auditEventFactory) {
        await this.runtimeEvents.appendRuntimeEventWithExecutor(
          tx,
          auditEventFactory(result),
        );
      }
      return result;
    });
  }

  private async appendResolutionAudit(
    executor: Executor,
    result: IdentityResolveResult,
    auditEventFactory: (
      result: IdentityResolveResult,
    ) => RuntimeEventPublishInput,
  ): Promise<IdentityResolveResult> {
    await this.runtimeEvents.appendRuntimeEventWithExecutor(
      executor,
      auditEventFactory(result),
    );
    return result;
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

  async addAlias(
    input: AddPersonAliasInput,
    auditEventFactory?: (
      alias: PersonAliasRecord,
    ) => import('../../../../domain/events/events.js').RuntimeEventPublishInput,
  ): Promise<PersonAliasRecord> {
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
      assertAliasTargetIsActive(person.status);
      await lockPersonAliasKey(tx, input);
      const duplicate = await this.findActiveAlias(tx, input);
      assertAliasOwnership(duplicate?.userId, input.personId);
      const unverifiedAlias = {
        ...input,
        verificationStatus: 'unverified' as const,
        evidence: {
          ...(input.evidence || {}),
          evidenceType: input.evidenceType,
        },
        timestamp: nowIso(),
      };
      let alias: PersonAliasRecord;
      if (duplicate) {
        alias =
          duplicate.verificationStatus === 'verified'
            ? toAlias(duplicate)
            : await this.insertAlias(tx, {
                ...unverifiedAlias,
                aliasId: duplicate.id,
              });
      } else {
        const retired = await this.findRetiredAlias(tx, input);
        assertRetiredAliasCanBeRebound(retired?.userId, input.personId);
        alias = await this.insertAlias(tx, {
          ...unverifiedAlias,
          aliasId: retired?.id,
        });
      }
      if (auditEventFactory) {
        await this.runtimeEvents.appendRuntimeEventWithExecutor(
          tx,
          auditEventFactory(alias),
        );
      }
      return alias;
    });
  }

  async retireAlias(
    input: RetirePersonAliasInput,
    auditEventFactory?: (
      alias: PersonAliasRecord,
    ) => import('../../../../domain/events/events.js').RuntimeEventPublishInput,
  ): Promise<PersonAliasRecord | null> {
    return this.db.transaction(async (tx) => {
      const timestamp = nowIso();
      const [row] = await tx
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
      if (!row) return null;
      const alias = toAlias(row);
      if (auditEventFactory) {
        await this.runtimeEvents.appendRuntimeEventWithExecutor(
          tx,
          auditEventFactory(alias),
        );
      }
      return alias;
    });
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

  async mergePeople(
    input: PersonMergeInput,
    auditEventFactory?: (
      result: PersonMergeApplyResult,
    ) => RuntimeEventPublishInput,
  ): Promise<PersonMergeApplyResult> {
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
      assertMergeablePeople(people, input.targetPersonId, input.sourcePersonId);
      const sourcePerson = people.find(
        (person) => person.id === input.sourcePersonId,
      )!;
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
        input.expectedFingerprint &&
        preview.fingerprint !== input.expectedFingerprint
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Merge preview is stale; run preview again before applying the merge.',
        );
      }
      assertMergeConflicts(
        aliasConflicts.length,
        preview.conflicts.length - aliasConflicts.length,
        conflictResolution,
      );
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
          memoryRowsMoved: moved.movedMemoryIds.length,
          conflictsJson: preview.conflicts,
          resultJson: {
            aliasesToMove: preview.aliasesToMove,
            movedAliasIds: preview.aliasesToMove.map((alias) => alias.id),
            movedMemoryIds: moved.movedMemoryIds,
            supersededMemoryRows: moved.supersededMemoryRows,
            sourcePerson: {
              personId: sourcePerson.id,
              appId: sourcePerson.appId,
              kind: sourcePerson.kind,
              displayName: sourcePerson.displayName,
              status: sourcePerson.status,
              createdAt: sourcePerson.createdAt,
              updatedAt: sourcePerson.updatedAt,
            },
            excludedMemoryScopes: preview.excludedMemoryScopes,
            fingerprint: preview.fingerprint,
          },
          createdAt: timestamp,
        })
        .returning();
      const result = auditToMergeApply(audit!, idempotencyKey, true);
      if (auditEventFactory) {
        await this.runtimeEvents.appendRuntimeEventWithExecutor(
          tx,
          auditEventFactory(result),
        );
      }
      return result;
    });
  }

  async unmergePerson(
    input: PersonUnmergeInput,
    auditEventFactory?: (
      result: PersonUnmergeResult,
    ) => RuntimeEventPublishInput,
  ): Promise<PersonUnmergeResult> {
    return this.db.transaction(async (tx) => {
      const audit = await findMergeAuditByIdForUpdate(
        tx,
        input.appId,
        input.auditId,
      );
      if (!audit || audit.targetPersonId !== input.targetPersonId) {
        throw new ApplicationError(
          'FORBIDDEN',
          'Person merge is not accessible to this app.',
        );
      }
      const snapshot = mergeUndoSnapshot(audit);
      if (snapshot.unmergedAt) {
        throw new ApplicationError(
          'CONFLICT',
          'Person merge is already unmerged.',
        );
      }
      if (snapshot.fingerprint !== input.expectedFingerprint) {
        throw new ApplicationError(
          'CONFLICT',
          'Merge fingerprint does not match the recorded audit.',
        );
      }
      const people = await this.lockPeopleForMerge(
        tx,
        input.appId,
        audit.targetPersonId,
        audit.sourcePersonId,
      );
      const sourcePerson = people.find(
        (person) => person.id === audit.sourcePersonId,
      );
      const targetPerson = people.find(
        (person) => person.id === audit.targetPersonId,
      );
      if (!sourcePerson || !targetPerson) {
        throw new ApplicationError(
          'FORBIDDEN',
          'Person merge is not accessible to this app.',
        );
      }
      if (
        sourcePerson.status !== 'archived' ||
        targetPerson.status !== 'active'
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Source must be archived and target must be active to unmerge.',
        );
      }
      if (
        sourcePerson.kind !== snapshot.sourcePerson.kind ||
        targetPerson.kind !== snapshot.sourcePerson.kind
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Person kind changed after merge; unmerge was refused.',
        );
      }
      const timestamp = nowIso();
      let aliasesRestored: ReturnType<typeof toAlias>[] = [];
      if (snapshot.movedAliasIds.length > 0) {
        const aliases = await tx
          .select({
            id: pgSchema.userAliasesPostgres.id,
            personId: pgSchema.userAliasesPostgres.userId,
            provider: pgSchema.userAliasesPostgres.provider,
            providerAccountId: pgSchema.userAliasesPostgres.providerAccountId,
            externalUserId: pgSchema.userAliasesPostgres.externalUserId,
            verificationStatus: pgSchema.userAliasesPostgres.verificationStatus,
          })
          .from(pgSchema.userAliasesPostgres)
          .where(
            and(
              eq(pgSchema.userAliasesPostgres.appId, input.appId),
              inArray(pgSchema.userAliasesPostgres.id, snapshot.movedAliasIds),
            ),
          )
          .orderBy(asc(pgSchema.userAliasesPostgres.id))
          .for('update');
        const preMergeById = new Map(
          snapshot.aliasesToMove.map((alias) => [alias.id, alias]),
        );
        const damaged = aliases.filter((alias) => {
          const before = preMergeById.get(alias.id);
          return (
            alias.personId !== audit.targetPersonId ||
            !before ||
            alias.provider !== before.provider ||
            (alias.providerAccountId ?? null) !==
              (before.providerAccountId ?? null) ||
            alias.externalUserId !== before.externalUserId ||
            alias.verificationStatus !== before.verificationStatus
          );
        });
        if (
          aliases.length !== snapshot.movedAliasIds.length ||
          damaged.length > 0
        ) {
          throw new ApplicationError(
            'CONFLICT',
            'Merge-owned aliases are no longer intact; unmerge was refused.',
          );
        }
        aliasesRestored = (
          await tx
            .update(pgSchema.userAliasesPostgres)
            .set({ userId: audit.sourcePersonId, updatedAt: timestamp })
            .where(
              and(
                eq(pgSchema.userAliasesPostgres.appId, input.appId),
                inArray(
                  pgSchema.userAliasesPostgres.id,
                  snapshot.movedAliasIds,
                ),
              ),
            )
            .returning()
        )
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(toAlias);
      }
      const memoryRowsRestored = await restorePersonalMemory(tx, {
        appId: input.appId,
        sourcePersonId: audit.sourcePersonId,
        targetPersonId: audit.targetPersonId,
        movedMemoryIds: snapshot.movedMemoryIds,
        supersededMemoryRows: snapshot.supersededMemoryRows,
        timestamp,
      });
      await tx
        .update(pgSchema.usersPostgres)
        .set({
          kind: snapshot.sourcePerson.kind,
          displayName: snapshot.sourcePerson.displayName,
          status: snapshot.sourcePerson.status,
          createdAt: snapshot.sourcePerson.createdAt,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(pgSchema.usersPostgres.appId, input.appId),
            eq(pgSchema.usersPostgres.id, audit.sourcePersonId),
          ),
        );
      await tx
        .update(pgSchema.personMergeAuditPostgres)
        .set({
          resultJson: sql`${pgSchema.personMergeAuditPostgres.resultJson} || jsonb_build_object('unmergedAt', ${timestamp}::text, 'unmergedBy', ${input.actor}::text)`,
          // Free the idempotency key: a repeat merge with the same deterministic
          // key must run fresh, not replay this spent (unmerged) audit.
          idempotencyKey: sql`${pgSchema.personMergeAuditPostgres.idempotencyKey} || ':unmerged:' || ${audit.id}`,
        })
        .where(
          and(
            eq(pgSchema.personMergeAuditPostgres.appId, input.appId),
            eq(pgSchema.personMergeAuditPostgres.id, audit.id),
          ),
        );
      const result: PersonUnmergeResult = {
        summary:
          'Person unmerge completed. The archived person and merge-owned data were restored.',
        auditId: audit.id,
        sourcePersonId: audit.sourcePersonId,
        targetPersonId: audit.targetPersonId,
        restoredPerson: {
          ...snapshot.sourcePerson,
          status: 'active',
          updatedAt: timestamp,
        },
        aliasesRestored,
        memoryRowsRestored,
        unmergedAt: timestamp,
      };
      if (auditEventFactory) {
        await this.runtimeEvents.appendRuntimeEventWithExecutor(
          tx,
          auditEventFactory(result),
        );
      }
      return result;
    });
  }

  private async hydratePerson(user: UserRow): Promise<PersonRecord> {
    const aliases = (
      await this.db
        .select()
        .from(pgSchema.userAliasesPostgres)
        .where(
          and(
            eq(pgSchema.userAliasesPostgres.appId, user.appId),
            eq(pgSchema.userAliasesPostgres.userId, user.id),
          ),
        )
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
      verificationStatus: 'unverified';
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
      verifiedAt: null,
      verifiedBy: null,
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

  private async createPerson(
    executor: Executor,
    input: {
      personId: string;
      appId: string;
      kind: 'human' | 'service';
      displayName: string;
      timestamp: string;
    },
  ): Promise<void> {
    await executor
      .insert(pgSchema.usersPostgres)
      .values({
        id: input.personId,
        appId: input.appId,
        kind: input.kind,
        displayName: input.displayName,
        status: 'active',
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      })
      .onConflictDoNothing();
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
    assertMergeablePeople(rows, targetPersonId, sourcePersonId);
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
        .orderBy(asc(pgSchema.userAliasesPostgres.id))
        .limit(PERSON_MERGE_DETAIL_LIMIT + 1)
    ).map(toAlias);
    assertDetailLimit('alias', aliases.length, PERSON_MERGE_DETAIL_LIMIT);
    const sourceMemoryRows = await executor
      .select({
        id: pgSchema.memoryItemsPostgres.id,
        updatedAt: pgSchema.memoryItemsPostgres.updatedAt,
        status: pgSchema.memoryItemsPostgres.status,
        kind: pgSchema.memoryItemsPostgres.kind,
        key: pgSchema.memoryItemsPostgres.key,
      })
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, input.appId),
          eq(pgSchema.memoryItemsPostgres.subjectType, 'user'),
          eq(pgSchema.memoryItemsPostgres.userId, input.sourcePersonId),
        ),
      );
    // Conflicts depend on BOTH sides: a target row inserted or archived after
    // preview must stale the fingerprint, not slip past it.
    const targetMemoryRows = await executor
      .select({
        id: pgSchema.memoryItemsPostgres.id,
        updatedAt: pgSchema.memoryItemsPostgres.updatedAt,
        status: pgSchema.memoryItemsPostgres.status,
        kind: pgSchema.memoryItemsPostgres.kind,
        key: pgSchema.memoryItemsPostgres.key,
      })
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, input.appId),
          eq(pgSchema.memoryItemsPostgres.subjectType, 'user'),
          eq(pgSchema.memoryItemsPostgres.userId, input.targetPersonId),
        ),
      );
    const sourceMemoryFingerprint = stableSha256Json({
      source: sourceMemoryRows
        .map((row) => ({ ...row }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      target: targetMemoryRows
        .map((row) => ({ ...row }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
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
    assertDetailLimit('conflict', conflicts.length, PERSON_MERGE_DETAIL_LIMIT);
    return {
      summary: 'Merge preview only. No data changed.',
      sourcePersonId: input.sourcePersonId,
      targetPersonId: input.targetPersonId,
      aliasesToMove: aliases,
      memoryRowsToMove: sourceMemoryRows.length,
      memoryRowsFingerprint: sourceMemoryFingerprint,
      excludedMemoryScopes: excluded,
      conflicts,
      fingerprint: personMergeFingerprint({
        summary: 'Merge preview only. No data changed.',
        sourcePersonId: input.sourcePersonId,
        targetPersonId: input.targetPersonId,
        aliasesToMove: aliases,
        memoryRowsToMove: sourceMemoryRows.length,
        memoryRowsFingerprint: sourceMemoryFingerprint,
        excludedMemoryScopes: excluded,
        conflicts,
      }),
    };
  }
}
