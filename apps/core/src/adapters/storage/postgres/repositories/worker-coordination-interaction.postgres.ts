import { isDeepStrictEqual } from 'node:util';

import { and, asc, eq, gt, isNotNull, not, sql } from 'drizzle-orm';

import type {
  PendingInteraction,
  PendingInteractionKind,
  PendingInteractionStatus,
} from '../../../../domain/ports/worker-coordination.js';
import type {
  LiveTurnCommand,
  LiveTurnCommandAppendInput,
} from '../../../../domain/ports/live-turns.js';
import type { PermissionCallbackClaimReference } from '../../../../domain/types.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { appendLiveTurnCommandInTransaction } from './live-turn-command-row.postgres.js';
import { activeRunLeaseTokenFence } from './run-lease-fence.postgres.js';
import { isUniqueViolation } from './worker-coordination-lease.postgres.js';

type PendingInteractionRow =
  typeof pgSchema.pendingInteractionsPostgres.$inferSelect;
type PermissionPromptRow =
  typeof pgSchema.permissionPromptsPostgres.$inferSelect;

export function toPendingInteraction(
  row: PendingInteractionRow,
): PendingInteraction {
  return {
    id: row.id,
    appId: row.appId,
    runId: row.runId,
    sourceAgentFolder: row.sourceAgentFolder,
    requestId: row.requestId,
    runLeaseToken: row.runLeaseToken,
    runLeaseFencingVersion: row.runLeaseFencingVersion,
    envelopeId: row.envelopeId,
    memberIndex: row.memberIndex,
    kind: row.kind as PendingInteractionKind,
    status: row.status as PendingInteractionStatus,
    payload: (row.payloadJson ?? {}) as Record<string, unknown>,
    callbackRoute: (row.callbackRouteJson ?? null) as Record<
      string,
      unknown
    > | null,
    idempotencyKey: row.idempotencyKey,
    approverRef: row.approverRef,
    resolution: (row.resolutionJson ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
  };
}

export async function createPendingInteractionRow(
  db: CanonicalDb,
  input: {
    id: string;
    appId: string;
    runId?: string | null;
    sourceAgentFolder: string;
    requestId: string;
    runLeaseToken?: string | null;
    runLeaseFencingVersion?: number | null;
    kind: PendingInteractionKind;
    payload: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    idempotencyKey: string;
    expiresAt: string;
    now: string;
  },
): Promise<PendingInteraction> {
  const table = pgSchema.pendingInteractionsPostgres;
  const values = {
    id: input.id,
    appId: input.appId,
    runId: input.runId ?? null,
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.requestId,
    runLeaseToken: input.runLeaseToken ?? null,
    runLeaseFencingVersion: input.runLeaseFencingVersion ?? null,
    envelopeId: null,
    memberIndex: null,
    kind: input.kind,
    status: 'pending' as const,
    payloadJson: input.payload,
    callbackRouteJson: input.callbackRoute ?? null,
    idempotencyKey: input.idempotencyKey,
    approverRef: null,
    resolutionJson: null,
    createdAt: input.now,
    expiresAt: input.expiresAt,
    resolvedAt: null,
  };
  if (input.kind === 'question') {
    const rows = await db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({
        target: table.idempotencyKey,
        set: values,
        setWhere: and(
          eq(table.kind, 'question'),
          eq(table.status, 'cancelled'),
        ),
      })
      .returning();
    if (rows[0]) return toPendingInteraction(rows[0]);
    const existing = await db
      .select()
      .from(table)
      .where(eq(table.idempotencyKey, input.idempotencyKey))
      .limit(1);
    return toPendingInteraction(existing[0]!);
  }
  try {
    const rows = await db.insert(table).values(values).returning();
    return toPendingInteraction(rows[0]!);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const incomingPayload = JSON.stringify(input.payload);
    const refreshed = await db
      .update(table)
      .set({
        payloadJson: sql`${incomingPayload}::jsonb || ${table.payloadJson}`,
        callbackRouteJson:
          input.callbackRoute ?? sql`${table.callbackRouteJson}`,
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.requestId,
        runLeaseToken: input.runLeaseToken ?? null,
        runLeaseFencingVersion: input.runLeaseFencingVersion ?? null,
        expiresAt: input.expiresAt,
      })
      .where(
        and(
          eq(table.idempotencyKey, input.idempotencyKey),
          eq(table.kind, 'permission'),
          eq(table.status, 'pending'),
        ),
      )
      .returning();
    if (refreshed[0]) return toPendingInteraction(refreshed[0]);
    const existing = await db
      .select()
      .from(table)
      .where(eq(table.idempotencyKey, input.idempotencyKey))
      .limit(1);
    return toPendingInteraction(existing[0]!);
  }
}

export async function resolvePendingInteractionRow(
  db: CanonicalDb,
  input: {
    idempotencyKey: string;
    status: 'resolved' | 'cancelled';
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    permissionCallbackClaim?: PermissionCallbackClaimReference | null;
    liveTurnCommand?: LiveTurnCommandAppendInput | null;
    now: string;
  },
): Promise<{ resolved: boolean; command: LiveTurnCommand | null }> {
  const table = pgSchema.pendingInteractionsPostgres;
  const prompts = pgSchema.permissionPromptsPostgres;
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select()
      .from(table)
      .where(eq(table.idempotencyKey, input.idempotencyKey))
      .for('update')
      .limit(1);
    if (!member) return { resolved: false, command: null };
    const [prompt] = member.envelopeId
      ? await tx
          .select()
          .from(prompts)
          .where(eq(prompts.id, member.envelopeId))
          .for('update')
          .limit(1)
      : [];
    const claimMatches = input.permissionCallbackClaim
      ? permissionResolutionClaimMatches(
          member,
          prompt,
          input.permissionCallbackClaim,
        )
      : !prompt?.claimId;
    if (!claimMatches) return { resolved: false, command: null };
    if (member.status !== 'pending') {
      return {
        resolved:
          member.kind === 'permission' &&
          member.status === input.status &&
          isDeepStrictEqual(member.resolutionJson, input.resolution),
        command: null,
      };
    }
    const rows = await tx
      .update(table)
      .set({
        status: input.status,
        resolutionJson: input.resolution,
        approverRef: input.approverRef ?? null,
        resolvedAt: input.now,
      })
      .where(and(eq(table.id, member.id), eq(table.status, 'pending')))
      .returning({ id: table.id });
    if (rows.length === 0) return { resolved: false, command: null };
    if (
      input.permissionCallbackClaim &&
      prompt?.settlementState === 'claimed'
    ) {
      await tx
        .update(prompts)
        .set({
          settlementState: 'settled',
          settledAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(prompts.id, prompt.id),
            eq(prompts.claimId, input.permissionCallbackClaim.id),
            eq(prompts.settlementState, 'claimed'),
          ),
        );
    }
    if (!input.liveTurnCommand) return { resolved: true, command: null };
    const appended = await appendLiveTurnCommandInTransaction(
      tx,
      input.liveTurnCommand,
      input.now,
    );
    if (!appended.command) {
      throw new Error('Active live turn rejected interaction resolution');
    }
    return { resolved: true, command: appended.command };
  });
}

function permissionResolutionClaimMatches(
  member: PendingInteractionRow,
  prompt: PermissionPromptRow | undefined,
  claim: PermissionCallbackClaimReference,
): boolean {
  if (!prompt || prompt.appId !== claim.scope.appId) return false;
  if (prompt.sourceAgentFolder !== claim.scope.sourceAgentFolder) return false;
  if (
    ['claimed', 'settled'].includes(prompt.settlementState) &&
    prompt.claimId === claim.id &&
    prompt.interactionId === claim.scope.interactionId
  ) {
    return true;
  }
  return (
    prompt.settlementState === 'review_each_expired' &&
    member.requestId !== null &&
    claim.id === `${prompt.claimId}:expired:${member.requestId}` &&
    claim.scope.interactionId === member.requestId
  );
}

export async function cancelPendingQuestionInteractionIfRunLeaseInactiveRow(
  db: CanonicalDb,
  input: { id: string; resolution: Record<string, unknown>; now: string },
): Promise<boolean> {
  const table = pgSchema.pendingInteractionsPostgres;
  const rows = await db
    .update(table)
    .set({
      status: 'cancelled',
      resolutionJson: input.resolution,
      approverRef: null,
      resolvedAt: input.now,
    })
    .where(
      and(
        eq(table.id, input.id),
        eq(table.kind, 'question'),
        eq(table.status, 'pending'),
        isNotNull(table.runId),
        isNotNull(table.runLeaseToken),
        sql`length(${table.runLeaseToken}) > 0`,
        isNotNull(table.runLeaseFencingVersion),
        gt(table.runLeaseFencingVersion, 0),
        not(
          activeRunLeaseTokenFence({
            runId: sql`${table.runId}`,
            leaseToken: sql`${table.runLeaseToken}`,
            fencingVersion: sql`${table.runLeaseFencingVersion}`,
            now: input.now,
          }),
        ),
      ),
    )
    .returning({ id: table.id });
  return rows.length > 0;
}

export async function updatePendingInteractionPayloadRow(
  db: CanonicalDb,
  input: {
    idempotencyKey: string;
    update: (
      payload: Record<string, unknown>,
    ) => Record<string, unknown> | null;
  },
): Promise<boolean> {
  const table = pgSchema.pendingInteractionsPostgres;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: table.id, payloadJson: table.payloadJson })
      .from(table)
      .where(
        and(
          eq(table.idempotencyKey, input.idempotencyKey),
          eq(table.status, 'pending'),
        ),
      )
      .for('update')
      .limit(1);
    if (!current) return false;
    const payload = input.update(
      (current.payloadJson ?? {}) as Record<string, unknown>,
    );
    if (!payload) return false;
    const rows = await tx
      .update(table)
      .set({ payloadJson: payload })
      .where(and(eq(table.id, current.id), eq(table.status, 'pending')))
      .returning({ id: table.id });
    return rows.length > 0;
  });
}

export async function findPendingInteractionByRequestRow(
  db: CanonicalDb,
  input: {
    appId: string;
    kind: PendingInteractionKind;
    sourceAgentFolder?: string;
    requestId: string;
    now: string;
  },
): Promise<PendingInteraction | null> {
  const table = pgSchema.pendingInteractionsPostgres;
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.appId, input.appId),
        eq(table.kind, input.kind),
        eq(table.status, 'pending'),
        eq(table.requestId, input.requestId),
        input.sourceAgentFolder
          ? eq(table.sourceAgentFolder, input.sourceAgentFolder)
          : undefined,
        gt(table.expiresAt, input.now),
      ),
    )
    .orderBy(asc(table.createdAt))
    .limit(1);
  return rows[0] ? toPendingInteraction(rows[0]) : null;
}

export async function findPendingInteractionByIdempotencyKeyRow(
  db: CanonicalDb,
  input: {
    appId: string;
    idempotencyKey: string;
    runId?: string | null;
    now: string;
  },
): Promise<PendingInteraction | null> {
  const table = pgSchema.pendingInteractionsPostgres;
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.appId, input.appId),
        eq(table.idempotencyKey, input.idempotencyKey),
        eq(table.status, 'pending'),
        gt(table.expiresAt, input.now),
        input.runId ? eq(table.runId, input.runId) : undefined,
      ),
    )
    .limit(1);
  return rows[0] ? toPendingInteraction(rows[0]) : null;
}
