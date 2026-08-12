import { and, desc, eq, sql } from 'drizzle-orm';

import type {
  CapabilityTemplateAmendmentProposal,
  CapabilityTemplateAmendmentRepository,
  CapabilityTemplateAmendmentStatus,
} from '../../../../domain/ports/capability-template-amendments.js';
import {
  semanticCapabilityFromToolCatalogItem,
  semanticCapabilityInputSchema,
  validateLocalCliCommandTemplate,
  type SemanticCapabilityDefinition,
} from '../../../../shared/semantic-capabilities.js';
import { stableSha256Json } from '../../../../shared/stable-hash.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const table = pgSchema.capabilityTemplateAmendmentProposalsPostgres;
const historyTable = pgSchema.capabilityTemplateAmendmentHistoryPostgres;

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

  async amendSemanticCapabilityCommandTemplates(
    input: Parameters<
      CapabilityTemplateAmendmentRepository['amendSemanticCapabilityCommandTemplates']
    >[0],
  ): ReturnType<
    CapabilityTemplateAmendmentRepository['amendSemanticCapabilityCommandTemplates']
  > {
    return this.db.transaction(async (tx) => {
      const [proposal] = await tx
        .select()
        .from(table)
        .where(
          and(eq(table.id, input.proposalId), eq(table.appId, input.appId)),
        )
        .for('update')
        .limit(1);
      if (!proposal) return { status: 'not_pending' as const };
      // Bind the amendment to the LOCKED proposal snapshot FIRST: caller
      // inputs must exactly match the reviewed row before ANY outcome —
      // including already_amended — is reported, so approval of one proposal
      // can never amend (or claim credit for) another capability's change.
      const rowTemplates = (proposal.proposedTemplates ?? []) as string[];
      const inputTemplates = [...input.proposedTemplates].sort();
      const snapshotMismatch =
        proposal.capabilityId !== input.capabilityId ||
        proposal.reviewedSchemaHash !== input.expectedReviewedSchemaHash ||
        rowTemplates.length !== inputTemplates.length ||
        [...rowTemplates]
          .sort()
          .some((template, index) => template !== inputTemplates[index]);
      if (snapshotMismatch) {
        return { status: 'not_pending' as const };
      }
      if (proposal.status === 'approved') {
        return { status: 'already_amended' as const };
      }
      if (proposal.status !== 'pending') {
        return { status: 'not_pending' as const };
      }

      const rows = await tx
        .select()
        .from(pgSchema.toolCatalogPostgres)
        .where(
          and(
            eq(pgSchema.toolCatalogPostgres.appId, input.appId),
            eq(pgSchema.toolCatalogPostgres.status, 'active'),
          ),
        )
        .for('update');
      const match = rows
        .map((row) => ({
          row,
          definition: semanticCapabilityFromToolCatalogItem({
            name: row.name,
            inputSchema: parseJsonObject(row.inputSchemaJson),
          }),
        }))
        .find(
          (candidate) =>
            candidate.definition?.capabilityId === input.capabilityId,
        );
      if (!match?.definition) return { status: 'stale' as const };

      const currentHash = stableSha256Json(match.definition);
      const amendedDefinition = amendCommandTemplates(
        match.definition,
        input.proposedTemplates,
      );
      const priorTemplates = commandTemplates(match.definition);
      const amendedTemplates = commandTemplates(amendedDefinition);
      if (currentHash !== input.expectedReviewedSchemaHash) {
        // A no-op amend is NOT proof of a concurrent approval: a changed
        // binding can silently reject every proposed template. Only report
        // already_amended when the proposal is truly contained in the
        // current template set.
        // ponytail: priorTemplates aggregates across bindings; capabilities
        // today carry ONE local_cli binding — revisit if multi-binding
        // capabilities ever exist (per-binding containment then).
        const proposedContained = input.proposedTemplates.every((template) =>
          priorTemplates.includes(template.trim()),
        );
        if (
          !proposedContained ||
          !sameTemplateSet(amendedTemplates, priorTemplates)
        ) {
          return { status: 'stale' as const };
        }
        await tx
          .update(table)
          .set({
            status: 'approved',
            decidedBy: input.approvedBy,
            decisionReason: 'Already amended by a concurrent approval.',
            decidedAt: input.approvedAt,
            updatedAt: input.approvedAt,
          })
          .where(
            and(eq(table.id, input.proposalId), eq(table.status, 'pending')),
          );
        return { status: 'already_amended' as const };
      }

      const nextInputSchemaJson = JSON.stringify(
        semanticCapabilityInputSchema(amendedDefinition),
      );
      const [updated] = await tx
        .update(pgSchema.toolCatalogPostgres)
        .set({
          inputSchemaJson: nextInputSchemaJson,
          updatedAt: input.approvedAt,
        })
        .where(
          and(
            eq(pgSchema.toolCatalogPostgres.id, match.row.id),
            eq(pgSchema.toolCatalogPostgres.appId, input.appId),
            eq(
              pgSchema.toolCatalogPostgres.inputSchemaJson,
              match.row.inputSchemaJson,
            ),
          ),
        )
        .returning({ id: pgSchema.toolCatalogPostgres.id });
      if (!updated) return { status: 'stale' as const };

      const auditEventId = `capability-amendment-audit-${globalThis.crypto.randomUUID()}`;
      const historyId = `capability-amendment-history-${globalThis.crypto.randomUUID()}`;
      await tx.insert(pgSchema.permissionAuditEventsPostgres).values({
        id: auditEventId,
        appId: input.appId,
        decisionId: null,
        actorId: input.approvedBy,
        eventType: 'capability_command_templates_amended',
        // Self-contained: history rows cascade with their proposal/agent,
        // so the surviving audit event must itself record what changed.
        payloadJson: JSON.stringify({
          proposalId: input.proposalId,
          historyId,
          capabilityId: input.capabilityId,
          priorTemplates,
          amendedTemplates,
        }),
        createdAt: input.approvedAt,
      });
      await tx.insert(historyTable).values({
        id: historyId,
        appId: input.appId,
        proposalId: input.proposalId,
        capabilityId: input.capabilityId,
        priorTemplates,
        amendedTemplates,
        approvedBy: input.approvedBy,
        auditEventId,
        createdAt: input.approvedAt,
      });
      await tx
        .update(table)
        .set({
          status: 'approved',
          decidedBy: input.approvedBy,
          decisionReason: 'Approved capability command template amendment.',
          decidedAt: input.approvedAt,
          updatedAt: input.approvedAt,
        })
        .where(
          and(eq(table.id, input.proposalId), eq(table.status, 'pending')),
        );
      return { status: 'amended' as const, historyId, auditEventId };
    });
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function amendCommandTemplates(
  definition: SemanticCapabilityDefinition,
  proposedTemplates: string[],
): SemanticCapabilityDefinition {
  return {
    ...definition,
    implementationBindings: definition.implementationBindings.map((binding) => {
      if (binding.kind !== 'local_cli' || !binding.executablePath) {
        return binding;
      }
      const matching = proposedTemplates.filter(
        (template) =>
          validateLocalCliCommandTemplate(binding.executablePath!, template).ok,
      );
      if (matching.length === 0) return binding;
      // Amendments ADD reviewed command forms — they never remove ones a
      // human already approved (the card promises an added input, not a
      // swap). Merge and dedupe with the existing set.
      const merged = [
        ...new Set([...(binding.commandTemplates ?? []), ...matching]),
      ];
      return { ...binding, commandTemplates: merged };
    }),
  };
}

function commandTemplates(definition: SemanticCapabilityDefinition): string[] {
  return [
    ...new Set(
      definition.implementationBindings.flatMap((binding) =>
        binding.kind === 'local_cli' ? (binding.commandTemplates ?? []) : [],
      ),
    ),
  ].sort();
}

function sameTemplateSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((template, index) => template === right[index])
  );
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
    providerAccountId: row.providerAccountId ?? null,
    status: row.status as CapabilityTemplateAmendmentStatus,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy ?? undefined,
    decisionReason: row.decisionReason ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt ?? undefined,
  };
}
