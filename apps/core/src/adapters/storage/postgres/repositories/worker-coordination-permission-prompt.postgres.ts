import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';

import type {
  PermissionPrompt,
  PermissionPromptGroup,
} from '../../../../domain/ports/worker-coordination.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
  PermissionCallbackScope,
  PermissionRecoveryEnvelope,
} from '../../../../domain/types.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { toPendingInteraction } from './worker-coordination-interaction.postgres.js';

type PermissionPromptRow =
  typeof pgSchema.permissionPromptsPostgres.$inferSelect;

function toPermissionPrompt(row: PermissionPromptRow): PermissionPrompt {
  const hasClaim = row.claimId !== null;
  if (
    hasClaim !== Boolean(row.claimMode && row.claimApproverRef && row.claimedAt)
  ) {
    throw new Error('Permission prompt claim columns are incomplete');
  }
  const claim = hasClaim
    ? ({
        id: row.claimId!,
        scope: {
          appId: row.appId,
          sourceAgentFolder: row.sourceAgentFolder,
          interactionId: row.interactionId,
        },
        intent: {
          mode: row.claimMode as PermissionApprovalDecisionMode,
          approverRef: row.claimApproverRef!,
          decidedAt: row.claimedAt!,
        },
        match: {
          kind: row.matchKind as 'individual' | 'batch',
          canonicalId: row.canonicalBatchId ?? row.interactionId,
          providerAliases: row.providerAliases,
        },
      } satisfies PermissionCallbackClaim)
    : null;
  return {
    id: row.id,
    parentEnvelopeId: row.parentEnvelopeId,
    appId: row.appId,
    sourceAgentFolder: row.sourceAgentFolder,
    interactionId: row.interactionId,
    matchKind: row.matchKind as 'individual' | 'batch',
    memberCount: row.memberCount,
    envelope: {
      version: 1,
      renderedDecisionOptions:
        row.renderedDecisionOptionsJson as PermissionApprovalDecisionMode[],
      targetJid: row.targetJid,
      approvalContextJid: row.approvalContextJid,
      threadId: row.threadId,
      decisionPolicy: row.decisionPolicy as
        PermissionApprovalRequest['decisionPolicy'] | null,
      renderedRequest:
        row.renderedRequestJson as PermissionRecoveryEnvelope['renderedRequest'],
    },
    fullView: (row.fullViewJson ?? null) as Record<string, unknown> | null,
    externalPromptProvider: row.externalPromptProvider,
    externalPromptConversationId: row.externalPromptConversationId,
    externalPromptMessageId: row.externalPromptMessageId,
    externalPromptThreadId: row.externalPromptThreadId,
    providerAliases: row.providerAliases,
    claim,
    settlementState: row.settlementState as PermissionPrompt['settlementState'],
    settledAt: row.settledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadPermissionPromptGroup(
  db: CanonicalDb,
  promptRow: PermissionPromptRow,
  input: { pendingOnly?: boolean; now?: string } = {},
): Promise<PermissionPromptGroup> {
  const table = pgSchema.pendingInteractionsPostgres;
  const memberRows = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.envelopeId, promptRow.id),
        input.pendingOnly ? eq(table.status, 'pending') : undefined,
        input.pendingOnly && input.now
          ? gt(table.expiresAt, input.now)
          : undefined,
      ),
    )
    .orderBy(asc(table.memberIndex));
  return {
    prompt: toPermissionPrompt(promptRow),
    members: memberRows.map(toPendingInteraction),
  };
}

export async function bindPendingPermissionPromptRows(
  db: CanonicalDb,
  input: {
    id: string;
    appId: string;
    sourceAgentFolder: string;
    interactionId: string;
    matchKind: 'individual' | 'batch';
    members: Array<{
      idempotencyKey: string;
      requestId: string;
      index: number;
    }>;
    envelope: PermissionRecoveryEnvelope;
    fullView?: Record<string, unknown> | null;
    externalPromptProvider?: string | null;
    externalPromptConversationId?: string | null;
    externalPromptMessageId?: string | null;
    externalPromptThreadId?: string | null;
    providerAliases: string[];
    now: string;
  },
): Promise<PermissionPromptGroup | null> {
  if (
    input.members.length === 0 ||
    new Set(input.members.map((member) => member.idempotencyKey)).size !==
      input.members.length ||
    new Set(input.members.map((member) => member.requestId)).size !==
      input.members.length ||
    input.members.some((member, index) => member.index !== index)
  ) {
    return null;
  }
  const interactions = pgSchema.pendingInteractionsPostgres;
  const prompts = pgSchema.permissionPromptsPostgres;
  return db.transaction(async (tx) => {
    const memberRows = await tx
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.appId, input.appId),
          eq(interactions.kind, 'permission'),
          eq(interactions.status, 'pending'),
          gt(interactions.expiresAt, input.now),
          inArray(
            interactions.idempotencyKey,
            input.members.map((member) => member.idempotencyKey),
          ),
        ),
      )
      .for('update');
    const rowsByKey = new Map(
      memberRows.map((row) => [row.idempotencyKey, row]),
    );
    if (
      memberRows.length !== input.members.length ||
      input.members.some((member) => {
        const row = rowsByKey.get(member.idempotencyKey);
        return (
          !row ||
          row.sourceAgentFolder !== input.sourceAgentFolder ||
          row.requestId !== member.requestId
        );
      })
    ) {
      return null;
    }
    const oldEnvelopeIds = [
      ...new Set(
        memberRows.flatMap((row) => (row.envelopeId ? [row.envelopeId] : [])),
      ),
    ];
    const oldPrompts = oldEnvelopeIds.length
      ? await tx
          .select()
          .from(prompts)
          .where(inArray(prompts.id, oldEnvelopeIds))
          .for('update')
      : [];
    if (
      oldPrompts.some((prompt) => {
        if (
          ['claimed', 'review_each_expired'].includes(prompt.settlementState)
        ) {
          return true;
        }
        return (
          prompt.settlementState === 'settled' &&
          !(
            input.matchKind === 'individual' &&
            prompt.matchKind === 'batch' &&
            prompt.claimMode === 'allow_persistent_rule'
          )
        );
      })
    ) {
      return null;
    }
    const openOldEnvelopeIds = oldPrompts
      .filter((prompt) => prompt.settlementState === 'open')
      .map((prompt) => prompt.id);
    const oldPendingMembers = openOldEnvelopeIds.length
      ? await tx
          .select({ idempotencyKey: interactions.idempotencyKey })
          .from(interactions)
          .where(
            and(
              inArray(interactions.envelopeId, openOldEnvelopeIds),
              eq(interactions.status, 'pending'),
            ),
          )
          .for('update')
      : [];
    const reboundKeys = new Set(
      input.members.map((member) => member.idempotencyKey),
    );
    if (
      oldPendingMembers.some(
        (member) => !reboundKeys.has(member.idempotencyKey),
      )
    ) {
      return null;
    }
    const parentEnvelopeIds = [
      ...new Set(
        oldPrompts.flatMap((prompt) => {
          if (input.matchKind !== 'individual') return [];
          if (
            prompt.matchKind === 'batch' &&
            prompt.settlementState === 'settled' &&
            prompt.claimMode === 'allow_persistent_rule'
          ) {
            return [prompt.id];
          }
          return prompt.parentEnvelopeId ? [prompt.parentEnvelopeId] : [];
        }),
      ),
    ];
    if (parentEnvelopeIds.length > 1) return null;
    if (oldEnvelopeIds.length > 0) {
      await tx
        .update(prompts)
        .set({ settlementState: 'superseded', updatedAt: input.now })
        .where(
          and(
            inArray(prompts.id, oldEnvelopeIds),
            eq(prompts.settlementState, 'open'),
          ),
        );
    }
    const [promptRow] = await tx
      .insert(prompts)
      .values({
        id: input.id,
        parentEnvelopeId: parentEnvelopeIds[0] ?? null,
        appId: input.appId,
        sourceAgentFolder: input.sourceAgentFolder,
        interactionId: input.interactionId,
        matchKind: input.matchKind,
        memberCount: input.members.length,
        renderedDecisionOptionsJson: input.envelope.renderedDecisionOptions,
        renderedRequestJson: input.envelope.renderedRequest,
        targetJid: input.envelope.targetJid,
        approvalContextJid: input.envelope.approvalContextJid,
        threadId: input.envelope.threadId,
        decisionPolicy: input.envelope.decisionPolicy,
        fullViewJson: input.fullView ?? null,
        externalPromptProvider: input.externalPromptProvider ?? null,
        externalPromptConversationId:
          input.externalPromptConversationId ?? null,
        externalPromptMessageId: input.externalPromptMessageId ?? null,
        externalPromptThreadId: input.externalPromptThreadId ?? null,
        providerAliases: [...new Set(input.providerAliases)],
        canonicalBatchId:
          input.matchKind === 'batch' ? input.interactionId : null,
        settlementState: 'open',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    for (const member of input.members) {
      await tx
        .update(interactions)
        .set({ envelopeId: input.id, memberIndex: member.index })
        .where(
          and(
            eq(interactions.idempotencyKey, member.idempotencyKey),
            eq(interactions.status, 'pending'),
          ),
        );
    }
    return loadPermissionPromptGroup(tx, promptRow!);
  });
}

export async function claimPendingPermissionCallbackRows(
  db: CanonicalDb,
  input: { claim: PermissionCallbackClaim },
): Promise<PermissionPromptGroup | null> {
  if (input.claim.match.canonicalId !== input.claim.scope.interactionId) {
    return null;
  }
  const prompts = pgSchema.permissionPromptsPostgres;
  const members = pgSchema.pendingInteractionsPostgres;
  const actualMemberCount = db
    .select({ value: sql<number>`count(*)::int` })
    .from(members)
    .where(eq(members.envelopeId, prompts.id));
  const invalidMember = db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.envelopeId, prompts.id),
        or(
          ne(members.appId, prompts.appId),
          ne(members.kind, 'permission'),
          ne(members.status, 'pending'),
          lte(members.expiresAt, input.claim.intent.decidedAt),
          isNull(members.sourceAgentFolder),
          ne(members.sourceAgentFolder, prompts.sourceAgentFolder),
          isNull(members.requestId),
          isNull(members.memberIndex),
          lt(members.memberIndex, 0),
          gte(members.memberIndex, prompts.memberCount),
        ),
      ),
    );
  const rows = await db
    .update(prompts)
    .set({
      claimId: input.claim.id,
      claimMode: input.claim.intent.mode,
      claimApproverRef: input.claim.intent.approverRef,
      claimedAt: input.claim.intent.decidedAt,
      settlementState: 'claimed',
      settledAt: null,
      updatedAt: input.claim.intent.decidedAt,
    })
    .where(
      and(
        eq(prompts.appId, input.claim.scope.appId),
        eq(prompts.sourceAgentFolder, input.claim.scope.sourceAgentFolder),
        eq(prompts.interactionId, input.claim.scope.interactionId),
        eq(prompts.matchKind, input.claim.match.kind),
        input.claim.match.kind === 'batch'
          ? eq(prompts.canonicalBatchId, input.claim.scope.interactionId)
          : isNull(prompts.canonicalBatchId),
        eq(prompts.settlementState, 'open'),
        isNull(prompts.claimId),
        gt(prompts.memberCount, 0),
        sql`(${actualMemberCount}) = ${prompts.memberCount}`,
        notExists(invalidMember),
        input.claim.match.providerAliases[0]
          ? sql`${input.claim.match.providerAliases[0]} = ANY(${prompts.providerAliases})`
          : undefined,
      ),
    )
    .returning();
  return rows[0] ? loadPermissionPromptGroup(db, rows[0]) : null;
}

export async function releasePendingPermissionCallbackRows(
  db: CanonicalDb,
  input: { claim: PermissionCallbackClaimReference; now: string },
): Promise<boolean> {
  const table = pgSchema.permissionPromptsPostgres;
  const rows = await db
    .update(table)
    .set({
      claimId: null,
      claimMode: null,
      claimApproverRef: null,
      claimedAt: null,
      settlementState: 'open',
      settledAt: null,
      updatedAt: input.now,
    })
    .where(promptClaimWhere(table, input.claim, 'claimed'))
    .returning({ id: table.id });
  return rows.length > 0;
}

export async function settlePendingPermissionCallbackRows(
  db: CanonicalDb,
  input: { claim: PermissionCallbackClaimReference; now: string },
): Promise<boolean> {
  const table = pgSchema.permissionPromptsPostgres;
  const rows = await db
    .update(table)
    .set({
      settlementState: 'settled',
      settledAt: input.now,
      updatedAt: input.now,
    })
    .where(promptClaimWhere(table, input.claim, 'claimed'))
    .returning({ id: table.id });
  if (rows.length > 0) return true;
  const existing = await db
    .select({ id: table.id })
    .from(table)
    .where(promptClaimWhere(table, input.claim, 'settled'))
    .limit(1);
  return existing.length > 0;
}

export async function expirePendingPermissionReviewEachRows(
  db: CanonicalDb,
  input: { claim: PermissionCallbackClaimReference; now: string },
): Promise<PermissionPromptGroup | null> {
  const table = pgSchema.permissionPromptsPostgres;
  const rows = await db
    .update(table)
    .set({
      settlementState: 'review_each_expired',
      settledAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(table.appId, input.claim.scope.appId),
        eq(table.sourceAgentFolder, input.claim.scope.sourceAgentFolder),
        eq(table.interactionId, input.claim.scope.interactionId),
        eq(table.claimId, input.claim.id),
        eq(table.matchKind, 'batch'),
        eq(table.claimMode, 'allow_persistent_rule'),
        or(
          eq(table.settlementState, 'claimed'),
          eq(table.settlementState, 'settled'),
        ),
      ),
    )
    .returning();
  return rows[0]
    ? loadPermissionPromptGroup(db, rows[0], { pendingOnly: true })
    : null;
}

export async function findPendingPermissionPromptRow(
  db: CanonicalDb,
  input: {
    scope: PermissionCallbackScope;
    now: string;
    includeTerminalSettlement?: boolean;
  },
): Promise<PermissionPromptGroup | null> {
  const prompts = pgSchema.permissionPromptsPostgres;
  const members = pgSchema.pendingInteractionsPostgres;
  const activeMember = db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.envelopeId, prompts.id),
        eq(members.status, 'pending'),
        gt(members.expiresAt, input.now),
      ),
    );
  const rows = await db
    .select()
    .from(prompts)
    .where(
      and(
        eq(prompts.appId, input.scope.appId),
        eq(prompts.sourceAgentFolder, input.scope.sourceAgentFolder),
        eq(prompts.interactionId, input.scope.interactionId),
        ne(prompts.settlementState, 'superseded'),
        input.includeTerminalSettlement
          ? or(
              exists(activeMember),
              eq(prompts.settlementState, 'settled'),
              eq(prompts.settlementState, 'review_each_expired'),
            )
          : exists(activeMember),
      ),
    )
    .orderBy(desc(prompts.updatedAt))
    .limit(1);
  return rows[0]
    ? loadPermissionPromptGroup(db, rows[0], {
        pendingOnly: true,
        now: input.includeTerminalSettlement ? undefined : input.now,
      })
    : null;
}

export async function findPendingPermissionPromptByMemberRow(
  db: CanonicalDb,
  input: {
    appId: string;
    sourceAgentFolder: string;
    requestId: string;
    now: string;
  },
): Promise<PermissionPromptGroup | null> {
  const members = pgSchema.pendingInteractionsPostgres;
  const rows = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.appId, input.appId),
        eq(members.kind, 'permission'),
        eq(members.status, 'pending'),
        eq(members.sourceAgentFolder, input.sourceAgentFolder),
        eq(members.requestId, input.requestId),
        gt(members.expiresAt, input.now),
        isNotNull(members.envelopeId),
      ),
    )
    .limit(1);
  if (!rows[0]?.envelopeId) return null;
  const prompts = pgSchema.permissionPromptsPostgres;
  const promptRows = await db
    .select()
    .from(prompts)
    .where(eq(prompts.id, rows[0].envelopeId))
    .limit(1);
  return promptRows[0]
    ? loadPermissionPromptGroup(db, promptRows[0], {
        pendingOnly: true,
        now: input.now,
      })
    : null;
}

export async function findPendingPermissionPromptByMessageRow(
  db: CanonicalDb,
  input: {
    appId: string;
    provider: string;
    conversationId: string;
    externalMessageId: string;
    threadId?: string | null;
    now: string;
  },
): Promise<PermissionPromptGroup | null> {
  const table = pgSchema.permissionPromptsPostgres;
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.appId, input.appId),
        eq(table.externalPromptProvider, input.provider),
        eq(table.externalPromptConversationId, input.conversationId),
        eq(table.externalPromptMessageId, input.externalMessageId),
        input.threadId
          ? eq(table.externalPromptThreadId, input.threadId)
          : isNull(table.externalPromptThreadId),
        ne(table.settlementState, 'superseded'),
      ),
    )
    .orderBy(desc(table.updatedAt))
    .limit(2);
  return rows.length === 1
    ? loadPermissionPromptGroup(db, rows[0], {
        pendingOnly: true,
        now: input.now,
      })
    : null;
}

function promptClaimWhere(
  table: typeof pgSchema.permissionPromptsPostgres,
  claim: PermissionCallbackClaimReference,
  settlementState: 'claimed' | 'settled',
) {
  return and(
    eq(table.appId, claim.scope.appId),
    eq(table.sourceAgentFolder, claim.scope.sourceAgentFolder),
    eq(table.interactionId, claim.scope.interactionId),
    eq(table.claimId, claim.id),
    eq(table.settlementState, settlementState),
  );
}
