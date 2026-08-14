import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import type { CapabilityTemplateApprovalIntentRepository } from '../../../../shared/capability-template-amendment.js';
import type { CapabilityTemplateAmendmentRepository } from '../../../../domain/ports/capability-template-amendments.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const table = pgSchema.capabilityTemplateAmendmentProposalsPostgres;
const intentTable = pgSchema.capabilityTemplateApprovalIntentsPostgres;
const targetTable = pgSchema.capabilityTemplateApprovalIntentTargetsPostgres;

type CanonicalTransaction = Parameters<
  Parameters<CanonicalDb['transaction']>[0]
>[0];

export async function claimDueApprovalIntents(
  db: CanonicalDb,
  input: Parameters<
    CapabilityTemplateApprovalIntentRepository['claimDueApprovalIntents']
  >[0],
): ReturnType<
  CapabilityTemplateApprovalIntentRepository['claimDueApprovalIntents']
> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(intentTable)
      .where(
        and(
          eq(intentTable.status, 'pending'),
          lte(intentTable.nextAttemptAt, input.now),
          or(
            isNull(intentTable.claimExpiresAt),
            lte(intentTable.claimExpiresAt, input.now),
          ),
        ),
      )
      .orderBy(asc(intentTable.nextAttemptAt), asc(intentTable.id))
      .limit(input.limit)
      .for('update', { skipLocked: true });
    const claimed = [];
    for (const intent of due) {
      // Fresh unguessable token per claim (fencing). Note for review
      // bundles: the template literal below can appear scrubbed as
      // 'redacted' by the secret gate - it is claimerId:randomUUID.
      const claimToken = `${input.claimerId}:${globalThis.crypto.randomUUID()}`;
      const [updated] = await tx
        .update(intentTable)
        .set({
          claimToken,
          claimExpiresAt: input.leaseExpiresAt,
          attemptCount: intent.attemptCount + 1,
          updatedAt: input.now,
        })
        .where(
          and(eq(intentTable.id, intent.id), eq(intentTable.status, 'pending')),
        )
        .returning();
      if (!updated) continue;
      const targets = await tx
        .select()
        .from(targetTable)
        .where(
          and(
            eq(targetTable.intentId, intent.id),
            eq(targetTable.status, 'pending'),
          ),
        )
        .orderBy(asc(targetTable.jobId));
      claimed.push({
        id: updated.id,
        appId: updated.appId,
        proposalId: updated.proposalId,
        capabilityId: updated.capabilityId,
        claimToken,
        attemptCount: updated.attemptCount,
        targets: targets.map((target) => ({
          jobId: target.jobId,
          expectedSetupFingerprint: target.expectedSetupFingerprint,
        })),
      });
    }
    return claimed;
  });
}

export async function settleApprovalIntentClaim(
  db: CanonicalDb,
  input: Parameters<
    CapabilityTemplateApprovalIntentRepository['settleApprovalIntentClaim']
  >[0],
): ReturnType<
  CapabilityTemplateApprovalIntentRepository['settleApprovalIntentClaim']
> {
  return db.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(intentTable)
      .where(eq(intentTable.id, input.intentId))
      .for('update')
      .limit(1);
    if (!intent || intent.status === 'superseded') return 'superseded';
    if (intent.status === 'completed') return 'completed';
    if (intent.claimToken !== input.claimToken) return 'pending';
    for (const outcome of input.outcomes) {
      await tx
        .update(targetTable)
        .set({
          status: outcome.status,
          updatedAt: input.now,
          completedAt: input.now,
        })
        .where(
          and(
            eq(targetTable.intentId, input.intentId),
            eq(targetTable.jobId, outcome.jobId),
            eq(targetTable.status, 'pending'),
          ),
        );
    }
    const [remaining] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(targetTable)
      .where(
        and(
          eq(targetTable.intentId, input.intentId),
          eq(targetTable.status, 'pending'),
        ),
      );
    let completed = (remaining?.count ?? 0) === 0;
    if (completed) {
      // Close the pause/approval snapshot race before completing: a job
      // whose readiness pass committed a fix_proposal pause AFTER the
      // approval's target snapshot would otherwise stay paused with no
      // recovery target forever. Adopt any such straggler as a fresh
      // target and keep the intent pending (review R4).
      const stragglers = await tx
        .select({
          jobId: pgSchema.canonicalJobsPostgres.id,
          setupFingerprint: sql<string>`${pgSchema.canonicalJobsPostgres.setupState} ->> 'fingerprint'`,
        })
        .from(pgSchema.canonicalJobsPostgres)
        .where(
          and(
            eq(pgSchema.canonicalJobsPostgres.appId, intent.appId),
            eq(pgSchema.canonicalJobsPostgres.status, 'paused'),
            sql`exists (
                select 1
                from jsonb_array_elements(coalesce(${pgSchema.canonicalJobsPostgres.setupState} -> 'blockers', '[]'::jsonb)) blocker
                where blocker -> 'action' ->> 'kind' = 'fix_proposal'
                  and blocker -> 'action' ->> 'proposalId' = ${intent.proposalId}
              )`,
            sql`not exists (
                select 1 from ${targetTable} existing
                where existing.intent_id = ${input.intentId}
                  and existing.job_id = ${pgSchema.canonicalJobsPostgres.id}
              )`,
          ),
        )
        .for('update');
      if (stragglers.length > 0) {
        await tx.insert(targetTable).values(
          stragglers.map((straggler) => ({
            intentId: input.intentId,
            jobId: straggler.jobId,
            expectedSetupFingerprint: straggler.setupFingerprint,
            status: 'pending',
            updatedAt: input.now,
          })),
        );
        completed = false;
      }
    }
    await tx
      .update(intentTable)
      .set({
        status: completed ? 'completed' : 'pending',
        nextAttemptAt: completed ? input.now : input.nextAttemptAt,
        claimToken: null,
        claimExpiresAt: null,
        lastError: input.error ?? null,
        updatedAt: input.now,
        completedAt: completed ? input.now : null,
      })
      .where(
        and(
          eq(intentTable.id, input.intentId),
          eq(intentTable.status, 'pending'),
          eq(intentTable.claimToken, input.claimToken),
        ),
      );
    return completed ? 'completed' : 'pending';
  });
}

// Tick-level closure of the pause/approval race (no cross-module lock):
// a readiness pause that commits after the intent's final straggler scan
// leaves a paused job with a fix_proposal blocker whose proposal is
// APPROVED but has no pending intent target. Each recovery tick adopts
// such orphans by reopening the intent and inserting the target.
export async function adoptOrphanedApprovalTargets(
  db: CanonicalDb,
  input: {
    now: string;
    limit?: number;
  },
): Promise<number> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  return db.transaction(async (tx) => {
    const orphans = await tx
      .select({
        jobId: pgSchema.canonicalJobsPostgres.id,
        appId: pgSchema.canonicalJobsPostgres.appId,
        setupFingerprint: sql<string>`${pgSchema.canonicalJobsPostgres.setupState} ->> 'fingerprint'`,
        proposalId: sql<string>`blocker_proposal.id`,
        capabilityId: sql<string>`blocker_proposal.capability_id`,
        intentId: sql<string | null>`intent.id`,
        intentStatus: sql<string | null>`intent.status`,
      })
      .from(pgSchema.canonicalJobsPostgres)
      .innerJoin(
        sql`lateral (
            select p.id, p.capability_id
            from jsonb_array_elements(coalesce(${pgSchema.canonicalJobsPostgres.setupState} -> 'blockers', '[]'::jsonb)) blocker
            join capability_template_amendment_proposals p
              on p.id = blocker -> 'action' ->> 'proposalId'
            where blocker -> 'action' ->> 'kind' = 'fix_proposal'
              and p.status = 'approved'
            limit 1
          ) blocker_proposal`,
        sql`true`,
      )
      .leftJoin(
        sql`lateral (
            select i.id, i.status from ${intentTable} i
            where i.app_id = ${pgSchema.canonicalJobsPostgres.appId}
              and i.capability_id = blocker_proposal.capability_id
            order by i.approved_at desc, i.id desc
            limit 1
          ) intent`,
        sql`true`,
      )
      .where(
        and(
          eq(pgSchema.canonicalJobsPostgres.status, 'paused'),
          sql`not exists (
              select 1
              from ${targetTable} pending_target
              join ${intentTable} pending_intent on pending_intent.id = pending_target.intent_id
              where pending_target.job_id = ${pgSchema.canonicalJobsPostgres.id}
                and pending_target.status = 'pending'
                and pending_intent.status = 'pending'
            )`,
        ),
      )
      .limit(limit);
    let adopted = 0;
    for (const orphan of orphans) {
      // Adopt only under the NEWEST live intent for the capability - a
      // superseded intent is never claimed, so inserting beneath it
      // would strand the job (review R9). A stale-proposal blocker will
      // be superseded by the live intent's own target classification.
      if (!orphan.intentId || orphan.intentStatus === 'superseded') {
        continue;
      }
      // Serialize with insertApprovalIntent: SAME lock order (advisory
      // lock FIRST, job rows after) or the two transactions deadlock
      // (review R12); then RE-CHECK that this intent is still the
      // newest - a concurrent newer approval must not race a reopen
      // into a second pending intent (review R11).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${orphan.appId}\n${orphan.capabilityId}`}, 0))`,
      );
      // The scan above ran UNLOCKED; re-lock and re-verify the job under
      // the advisory lock before mutating anything.
      const [lockedJob] = await tx
        .select({ id: pgSchema.canonicalJobsPostgres.id })
        .from(pgSchema.canonicalJobsPostgres)
        .where(
          and(
            eq(pgSchema.canonicalJobsPostgres.id, orphan.jobId),
            eq(pgSchema.canonicalJobsPostgres.status, 'paused'),
            sql`exists (
                select 1
                from jsonb_array_elements(coalesce(${pgSchema.canonicalJobsPostgres.setupState} -> 'blockers', '[]'::jsonb)) blocker
                where blocker -> 'action' ->> 'kind' = 'fix_proposal'
                  and blocker -> 'action' ->> 'proposalId' = ${orphan.proposalId}
              )`,
          ),
        )
        .for('update')
        .limit(1);
      if (!lockedJob) continue;
      const [stillNewest] = await tx
        .select({ id: intentTable.id, status: intentTable.status })
        .from(intentTable)
        .where(
          and(
            eq(intentTable.appId, orphan.appId),
            eq(intentTable.capabilityId, orphan.capabilityId),
          ),
        )
        .orderBy(desc(intentTable.approvedAt), desc(intentTable.id))
        .limit(1);
      if (
        !stillNewest ||
        stillNewest.id !== orphan.intentId ||
        stillNewest.status === 'superseded'
      ) {
        continue;
      }
      const reopened = await tx
        .update(intentTable)
        .set({
          status: 'pending',
          nextAttemptAt: input.now,
          claimToken: null,
          claimExpiresAt: null,
          completedAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(intentTable.id, orphan.intentId),
            inArray(intentTable.status, ['pending', 'completed']),
          ),
        )
        .returning({ id: intentTable.id });
      if (reopened.length === 0) continue;
      // Upsert BACK to pending: an earlier attempt may have left a
      // terminal target row, which would make the reopened intent
      // complete again without touching the job (review R9).
      await tx
        .insert(targetTable)
        .values({
          intentId: orphan.intentId,
          jobId: orphan.jobId,
          expectedSetupFingerprint: orphan.setupFingerprint,
          status: 'pending',
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [targetTable.intentId, targetTable.jobId],
          set: {
            status: 'pending',
            expectedSetupFingerprint: orphan.setupFingerprint,
            completedAt: null,
            updatedAt: input.now,
          },
        });
      adopted += 1;
    }
    return adopted;
  });
}

export async function renewApprovalIntentClaim(
  db: CanonicalDb,
  input: {
    intentId: string;
    claimToken: string;
    leaseExpiresAt: string;
    now: string;
  },
): Promise<boolean> {
  const rows = await db
    .update(intentTable)
    .set({ claimExpiresAt: input.leaseExpiresAt, updatedAt: input.now })
    .where(
      and(
        eq(intentTable.id, input.intentId),
        eq(intentTable.status, 'pending'),
        eq(intentTable.claimToken, input.claimToken),
      ),
    )
    .returning({ id: intentTable.id });
  return rows.length > 0;
}

export async function insertApprovalIntent(
  tx: CanonicalTransaction,
  proposal: typeof table.$inferSelect,
  input: Parameters<
    CapabilityTemplateAmendmentRepository['amendSemanticCapabilityCommandTemplates']
  >[0],
): Promise<void> {
  const intentId = `capability-amendment-intent:${proposal.id}`;
  // Serialize all approvals for one app-wide capability. A newer approval
  // supersedes the prior recovery intent before its own target snapshot is
  // inserted, so two recovery workers cannot resume against stale authority.
  await tx.execute(
    // Newline separator, NOT NUL: a NUL byte is invalid UTF8 for a text
    // parameter (error 22021) and neither id can contain a newline.
    sql`select pg_advisory_xact_lock(hashtextextended(${`${input.appId}\n${input.capabilityId}`}, 0))`,
  );
  const [existing] = await tx
    .select({ id: intentTable.id })
    .from(intentTable)
    .where(eq(intentTable.proposalId, proposal.id))
    .limit(1);
  if (existing) return;
  // Newer approval wins: supersede only OLDER (or equal) pending
  // intents; if a strictly newer pending intent already exists, this
  // approval's intent is inserted as superseded instead (review R2).
  // ANY newer intent - pending, completed, or itself superseded -
  // means newer authority exists; the older approval's intent must not
  // resume jobs under stale templates (review R3).
  // Deterministic TOTAL order (approvedAt, id): equal-millisecond
  // approvals must resolve the same way everywhere - here, in the
  // supersede below, and in orphan adoption's ordering (review R11).
  const [newerPending] = await tx
    .select({ id: intentTable.id })
    .from(intentTable)
    .where(
      and(
        eq(intentTable.appId, input.appId),
        eq(intentTable.capabilityId, input.capabilityId),
        or(
          gt(intentTable.approvedAt, input.approvedAt),
          and(
            eq(intentTable.approvedAt, input.approvedAt),
            gt(intentTable.id, intentId),
          ),
        ),
      ),
    )
    .limit(1);
  await tx
    .update(intentTable)
    .set({
      status: 'superseded',
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: input.approvedAt,
      completedAt: input.approvedAt,
    })
    .where(
      and(
        eq(intentTable.appId, input.appId),
        eq(intentTable.capabilityId, input.capabilityId),
        eq(intentTable.status, 'pending'),
        or(
          lt(intentTable.approvedAt, input.approvedAt),
          and(
            eq(intentTable.approvedAt, input.approvedAt),
            lte(intentTable.id, intentId),
          ),
        ),
      ),
    );
  if (newerPending) {
    await tx.insert(intentTable).values({
      id: intentId,
      appId: input.appId,
      proposalId: proposal.id,
      capabilityId: input.capabilityId,
      status: 'superseded',
      nextAttemptAt: input.approvedAt,
      approvedAt: input.approvedAt,
      createdAt: input.approvedAt,
      updatedAt: input.approvedAt,
      completedAt: input.approvedAt,
    });
    return;
  }
  const targets = await tx
    .select({
      jobId: pgSchema.canonicalJobsPostgres.id,
      setupFingerprint: sql<string>`${pgSchema.canonicalJobsPostgres.setupState} ->> 'fingerprint'`,
    })
    .from(pgSchema.canonicalJobsPostgres)
    .where(
      and(
        eq(pgSchema.canonicalJobsPostgres.appId, input.appId),
        eq(pgSchema.canonicalJobsPostgres.status, 'paused'),
        sql`exists (
            select 1
            from jsonb_array_elements(coalesce(${pgSchema.canonicalJobsPostgres.setupState} -> 'blockers', '[]'::jsonb)) blocker
            join capability_template_amendment_proposals blocker_proposal
              on blocker_proposal.id = blocker -> 'action' ->> 'proposalId'
            where blocker -> 'action' ->> 'kind' = 'fix_proposal'
              and blocker_proposal.app_id = ${input.appId}
              and blocker_proposal.capability_id = ${input.capabilityId}
          )`,
      ),
    )
    .for('update');
  // ALWAYS pending - even with zero snapshot targets: a racing
  // readiness pass can commit a fix_proposal pause after this snapshot,
  // and only the recovery pass's straggler adoption can see it. The
  // first recovery pass completes an intent that stays empty (R5).
  await tx.insert(intentTable).values({
    id: intentId,
    appId: input.appId,
    proposalId: proposal.id,
    capabilityId: input.capabilityId,
    status: 'pending',
    nextAttemptAt: input.approvedAt,
    approvedAt: input.approvedAt,
    createdAt: input.approvedAt,
    updatedAt: input.approvedAt,
    completedAt: null,
  });
  if (targets.length > 0) {
    await tx.insert(targetTable).values(
      targets.map((target) => ({
        intentId,
        jobId: target.jobId,
        expectedSetupFingerprint: target.setupFingerprint,
        status: 'pending' as const,
        updatedAt: input.approvedAt,
      })),
    );
  }
}
