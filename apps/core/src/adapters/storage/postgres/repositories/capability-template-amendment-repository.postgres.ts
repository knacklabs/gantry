import { and, desc, eq, sql } from 'drizzle-orm';

import type {
  CapabilityTemplateAmendmentProposal,
  CapabilityTemplateAmendmentRepository,
  CapabilityTemplateAmendmentStatus,
} from '../../../../domain/ports/capability-template-amendments.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const table = pgSchema.capabilityTemplateAmendmentProposalsPostgres;

export class PostgresCapabilityTemplateAmendmentRepository implements CapabilityTemplateAmendmentRepository {
  constructor(private readonly db: CanonicalDb) {}

  async claimPending(
    input: Parameters<CapabilityTemplateAmendmentRepository['claimPending']>[0],
  ): ReturnType<CapabilityTemplateAmendmentRepository['claimPending']> {
    return this.claimPendingAttempt(input, 2);
  }

  private async claimPendingAttempt(
    input: Parameters<CapabilityTemplateAmendmentRepository['claimPending']>[0],
    attemptsLeft: number,
  ): ReturnType<CapabilityTemplateAmendmentRepository['claimPending']> {
    // DEDUPE DESIGN (decision 0122 — pinned; reviewers keep re-litigating in
    // both directions): the canonical identity is (app, capability, proposed
    // templates, observed argv) WITHOUT the schema hash; the hash scopes
    // terminal dedupe to the reviewed definition. Same definition + terminal
    // decision => return it (deny stays terminal, approve reports itself).
    // Definition changed => a stale PENDING row is superseded and a fresh
    // proposal opens; a terminal row for another revision does not block.
    // All inside one transaction with the canonical-key rows locked so a
    // concurrent decision cannot interleave between lookup and insert.
    const outcome: {
      proposal: ReturnType<typeof mapRow>;
      created: boolean;
      retry?: boolean;
    } = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.appId, input.appId),
            eq(table.canonicalKey, input.canonicalKey),
          ),
        )
        .orderBy(desc(table.createdAt))
        .for('update');
      const decidedForThisDefinition = rows.find(
        (row) =>
          row.status !== 'pending' &&
          // A system-superseded row is bookkeeping, not a human decision —
          // it must never block a fresh review if the definition returns.
          row.decidedBy !== 'system:superseded' &&
          row.reviewedSchemaHash === input.reviewedSchemaHash,
      );
      const pending = rows.find((row) => row.status === 'pending');
      if (decidedForThisDefinition) {
        if (
          pending &&
          pending.reviewedSchemaHash !== input.reviewedSchemaHash
        ) {
          // A definition change back to a decided revision must not leave an
          // obsolete pending card actionable for the abandoned revision.
          await tx
            .update(table)
            .set({
              status: 'denied',
              decidedBy: 'system:superseded',
              decisionReason: 'Superseded by a capability definition change.',
              decidedAt: input.now,
              updatedAt: input.now,
            })
            .where(eq(table.id, pending.id));
        }
        return { proposal: mapRow(decidedForThisDefinition), created: false };
      }
      if (pending && pending.reviewedSchemaHash === input.reviewedSchemaHash) {
        return { proposal: mapRow(pending), created: false };
      }
      if (pending) {
        // Definition changed under an open proposal: supersede it so the CAS
        // can never apply stale evidence and a fresh card reflects reality.
        await tx
          .update(table)
          .set({
            status: 'denied',
            decidedBy: 'system:superseded',
            decisionReason: 'Superseded by a capability definition change.',
            decidedAt: input.now,
            updatedAt: input.now,
          })
          .where(eq(table.id, pending.id));
      }
      const [created] = await tx
        .insert(table)
        .values({
          id: input.id,
          appId: input.appId,
          agentId: input.agentId,
          capabilityId: input.capabilityId,
          canonicalKey: input.canonicalKey,
          currentTemplates: input.currentTemplates,
          proposedTemplates: input.proposedTemplates,
          observedArgv: input.observedArgv,
          reviewedSchemaHash: input.reviewedSchemaHash,
          widening: input.widening,
          status: 'pending',
          requestedBy: input.requestedBy,
          jobId: input.jobId ?? null,
          conversationJid: input.conversationJid ?? null,
          threadId: input.threadId ?? null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: [table.appId, table.canonicalKey],
          where: sql`${table.status} = 'pending'`,
        })
        .returning();
      if (!created) {
        // Two first-claimers can race past the FOR UPDATE (no row existed to
        // lock); the partial unique index picks one winner — return it.
        const [winner] = await tx
          .select()
          .from(table)
          .where(
            and(
              eq(table.appId, input.appId),
              eq(table.canonicalKey, input.canonicalKey),
              eq(table.status, 'pending'),
            ),
          )
          .limit(1);
        if (!winner) {
          throw new Error(
            'Capability template amendment claim was not persisted.',
          );
        }
        // ponytail: bounded 2-attempt retry; a 3-way first-claim race across
        // DIFFERENT definition revisions can still hand the exhausted loser a
        // hash-mismatched pending proposal. Revisions change via human
        // approvals, so concurrent multi-revision first-claims are pathological;
        // worst case is one stale card that the CAS staleness check then
        // supersedes on the next claim. Upgrade path: serialize claims with an
        // advisory lock per canonical key if this ever shows up in practice.
        if (
          winner.reviewedSchemaHash !== input.reviewedSchemaHash &&
          attemptsLeft > 1
        ) {
          // A first-claim race lost to a DIFFERENT definition revision: retry
          // once — the second pass locks the winner row and supersedes it.
          return { proposal: mapRow(winner), created: false, retry: true };
        }
        return { proposal: mapRow(winner), created: false };
      }
      return { proposal: mapRow(created), created: true };
    });
    if (outcome.retry) {
      return this.claimPendingAttempt(input, attemptsLeft - 1);
    }
    return { proposal: outcome.proposal, created: outcome.created };
  }

  async getById(
    id: string,
  ): Promise<CapabilityTemplateAmendmentProposal | null> {
    const [row] = await this.db
      .select()
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async markDecision(
    input: Parameters<CapabilityTemplateAmendmentRepository['markDecision']>[0],
  ): ReturnType<CapabilityTemplateAmendmentRepository['markDecision']> {
    const [row] = await this.db
      .update(table)
      .set({
        status: input.status,
        decidedBy: input.decidedBy,
        decisionReason: input.decisionReason ?? null,
        decidedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(eq(table.id, input.id), eq(table.status, 'pending')))
      .returning();
    return row ? mapRow(row) : null;
  }
}

function mapRow(
  row: typeof table.$inferSelect,
): CapabilityTemplateAmendmentProposal {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    capabilityId: row.capabilityId,
    canonicalKey: row.canonicalKey,
    currentTemplates: row.currentTemplates,
    proposedTemplates: row.proposedTemplates,
    observedArgv: row.observedArgv,
    reviewedSchemaHash: row.reviewedSchemaHash,
    widening: row.widening,
    jobId: row.jobId ?? null,
    conversationJid: row.conversationJid ?? null,
    threadId: row.threadId ?? null,
    status: row.status as CapabilityTemplateAmendmentStatus,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy ?? undefined,
    decisionReason: row.decisionReason ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt ?? undefined,
  };
}
