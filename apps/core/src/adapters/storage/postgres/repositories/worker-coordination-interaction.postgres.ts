import {
  and,
  eq,
  exists,
  isNotNull,
  not,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  PendingInteraction,
  PendingInteractionKind,
  PendingInteractionStatus,
} from '../../../../domain/ports/worker-coordination.js';
import type {
  LiveTurnCommand,
  LiveTurnCommandAppendInput,
} from '../../../../domain/ports/live-turns.js';
import type {
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
  PermissionCallbackScope,
} from '../../../../domain/types.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { appendLiveTurnCommandInTransaction } from './live-turn-command-row.postgres.js';
import { activeRunLeaseTokenFence } from './run-lease-fence.postgres.js';
import { isUniqueViolation } from './worker-coordination-lease.postgres.js';

export function toPendingInteraction(
  row: typeof pgSchema.pendingInteractionsPostgres.$inferSelect,
): PendingInteraction {
  return {
    id: row.id,
    appId: row.appId,
    runId: row.runId,
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
    kind: PendingInteractionKind;
    payload: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    idempotencyKey: string;
    expiresAt: string;
    now: string;
  },
): Promise<PendingInteraction> {
  const table = pgSchema.pendingInteractionsPostgres;
  if (input.kind === 'question') {
    const values = {
      id: input.id,
      appId: input.appId,
      runId: input.runId ?? null,
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
  const incomingPayload = JSON.stringify(input.payload);
  try {
    const rows = await db
      .insert(table)
      .values({
        id: input.id,
        appId: input.appId,
        runId: input.runId ?? null,
        kind: input.kind,
        status: 'pending',
        payloadJson: input.payload,
        callbackRouteJson: input.callbackRoute ?? null,
        idempotencyKey: input.idempotencyKey,
        approverRef: null,
        resolutionJson: null,
        createdAt: input.now,
        expiresAt: input.expiresAt,
        resolvedAt: null,
      })
      .returning();
    return toPendingInteraction(rows[0]!);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const refreshedPayload = sql`(${incomingPayload}::jsonb || ${table.payloadJson})`;
    const refreshed = await db
      .update(table)
      .set({
        payloadJson: sql`CASE
          WHEN ${table.payloadJson} ? 'permissionCallbackClaim'
            THEN (${refreshedPayload}
              - 'permissionBatchCallbackId'
              - 'permissionCallbackId')
              || jsonb_build_object(
                'permissionCallbackClaim',
                ${table.payloadJson} -> 'permissionCallbackClaim'
              )
          WHEN ${table.payloadJson} ? 'permissionCallbackSettlement'
            THEN (${refreshedPayload}
              - 'permissionBatchCallbackId'
              - 'permissionCallbackId')
              || jsonb_build_object(
                'permissionCallbackSettlement',
                ${table.payloadJson} -> 'permissionCallbackSettlement'
              )
              || CASE
                WHEN NOT (${table.payloadJson} ? 'permissionBatchCallbackId')
                  AND jsonb_typeof(${table.payloadJson} -> 'permissionCallbackId') = 'string'
                  THEN jsonb_build_object(
                    'permissionCallbackId',
                    ${table.payloadJson} -> 'permissionCallbackId'
                  )
                ELSE '{}'::jsonb
              END
          ELSE ${refreshedPayload}
        END`,
        callbackRouteJson:
          input.callbackRoute ?? sql`${table.callbackRouteJson}`,
        expiresAt: input.expiresAt,
      })
      .where(
        and(
          eq(table.idempotencyKey, input.idempotencyKey),
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
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(table)
      .set({
        status: input.status,
        resolutionJson: input.resolution,
        approverRef: input.approverRef ?? null,
        resolvedAt: input.now,
        ...(input.permissionCallbackClaim
          ? {
              payloadJson: sql`(${table.payloadJson} - 'permissionCallbackClaim')
                || jsonb_build_object(
                  'permissionCallbackSettlement',
                  (${table.payloadJson} -> 'permissionCallbackClaim')
                    || jsonb_build_object('settledAt', ${input.now}::text)
                )`,
            }
          : {}),
      })
      .where(
        and(
          eq(table.idempotencyKey, input.idempotencyKey),
          eq(table.status, 'pending'),
          input.permissionCallbackClaim
            ? and(
                eq(table.appId, input.permissionCallbackClaim.scope.appId),
                sql`${table.payloadJson} #>> '{permissionCallbackClaim,id}' = ${input.permissionCallbackClaim.id}`,
                sql`${table.payloadJson} #>> '{permissionCallbackClaim,scope,interactionId}' = ${input.permissionCallbackClaim.scope.interactionId}`,
                sql`${table.payloadJson} #>> '{permissionCallbackClaim,scope,sourceAgentFolder}' = ${input.permissionCallbackClaim.scope.sourceAgentFolder}`,
              )
            : sql`NOT (${table.payloadJson} ? 'permissionCallbackClaim')`,
        ),
      )
      .returning({ id: table.id });
    if (rows.length === 0) return { resolved: false, command: null };
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

export async function cancelPendingQuestionInteractionIfRunLeaseInactiveRow(
  db: CanonicalDb,
  input: {
    id: string;
    resolution: Record<string, unknown>;
    now: string;
  },
): Promise<boolean> {
  const table = pgSchema.pendingInteractionsPostgres;
  const leaseToken = sql`${table.payloadJson} ->> 'runLeaseToken'`;
  const fencingVersionText = sql`${table.payloadJson} ->> 'runLeaseFencingVersion'`;
  const fencingVersion = sql`(${fencingVersionText})::numeric`;
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
        sql`jsonb_typeof(${table.payloadJson} -> 'runLeaseToken') = 'string'`,
        sql`length(${leaseToken}) > 0`,
        sql`jsonb_typeof(${table.payloadJson} -> 'runLeaseFencingVersion') = 'number'`,
        sql`${fencingVersionText} ~ '^[1-9][0-9]*$'`,
        not(
          activeRunLeaseTokenFence({
            runId: sql`${table.runId}`,
            leaseToken,
            fencingVersion,
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

export async function claimPendingPermissionCallbackRows(
  db: CanonicalDb,
  input: { claim: PermissionCallbackClaim },
): Promise<PendingInteraction[]> {
  if (input.claim.match.canonicalId !== input.claim.scope.interactionId) {
    return [];
  }
  const table = pgSchema.pendingInteractionsPostgres;
  const locator = alias(table, 'permission_callback_locator');
  const claimed = alias(table, 'permission_callback_claimed');
  const batchMember = alias(table, 'permission_callback_batch_member');
  const claim = JSON.stringify(input.claim);
  const sourceAgentFolder = sql`COALESCE(
    ${locator.payloadJson} ->> 'sourceAgentFolder',
    ${locator.payloadJson} #>> '{request,sourceAgentFolder}'
  )`;
  const batchMemberSourceAgentFolder = sql`COALESCE(
    ${batchMember.payloadJson} ->> 'sourceAgentFolder',
    ${batchMember.payloadJson} #>> '{request,sourceAgentFolder}'
  )`;
  const exactBatchMemberCount = db
    .select({ count: sql<number>`count(*)` })
    .from(batchMember)
    .where(
      and(
        eq(batchMember.appId, input.claim.scope.appId),
        eq(batchMember.kind, 'permission'),
        eq(batchMember.status, 'pending'),
        sql`${batchMember.expiresAt} > ${input.claim.intent.decidedAt}`,
        sql`${batchMemberSourceAgentFolder} = ${input.claim.scope.sourceAgentFolder}`,
        sql`${batchMember.payloadJson} ->> 'permissionBatchCallbackId' = ${input.claim.scope.interactionId}`,
        sql`jsonb_typeof(${batchMember.payloadJson} -> 'permissionBatchRequestIds') = 'array'`,
        sql`(${batchMember.payloadJson} -> 'permissionBatchRequestIds') @> (${locator.payloadJson} -> 'permissionBatchRequestIds')`,
        sql`(${locator.payloadJson} -> 'permissionBatchRequestIds') @> (${batchMember.payloadJson} -> 'permissionBatchRequestIds')`,
        sql`(${locator.payloadJson} -> 'permissionBatchRequestIds') ? (${batchMember.payloadJson} ->> 'requestId')`,
      ),
    );
  const markedBatchMemberCount = db
    .select({
      count: sql<number>`count(DISTINCT ${batchMember.payloadJson} ->> 'requestId')`,
    })
    .from(batchMember)
    .where(
      and(
        eq(batchMember.appId, input.claim.scope.appId),
        eq(batchMember.kind, 'permission'),
        eq(batchMember.status, 'pending'),
        sql`${batchMember.expiresAt} > ${input.claim.intent.decidedAt}`,
        sql`${batchMemberSourceAgentFolder} = ${input.claim.scope.sourceAgentFolder}`,
        sql`${batchMember.payloadJson} ->> 'permissionBatchCallbackId' = ${input.claim.scope.interactionId}`,
      ),
    );
  const batchClaimGuard =
    input.claim.match.kind === 'batch'
      ? and(
          input.claim.match.providerAliases[0]
            ? exists(
                db
                  .select({ id: locator.id })
                  .from(locator)
                  .where(
                    and(
                      eq(locator.appId, input.claim.scope.appId),
                      eq(locator.kind, 'permission'),
                      eq(locator.status, 'pending'),
                      sql`${locator.expiresAt} > ${input.claim.intent.decidedAt}`,
                      sql`${sourceAgentFolder} = ${input.claim.scope.sourceAgentFolder}`,
                      sql`${locator.payloadJson} ->> 'permissionBatchCallbackId' = ${input.claim.scope.interactionId}`,
                      sql`${locator.payloadJson} ->> 'permissionCallbackId' = ${input.claim.match.providerAliases[0]}`,
                      sql`jsonb_typeof(${locator.payloadJson} -> 'permissionBatchRequestIds') = 'array'`,
                      sql`jsonb_array_length(${locator.payloadJson} -> 'permissionBatchRequestIds') > 0`,
                      sql`(${exactBatchMemberCount}) = jsonb_array_length(${locator.payloadJson} -> 'permissionBatchRequestIds')`,
                      sql`(${markedBatchMemberCount}) = jsonb_array_length(${locator.payloadJson} -> 'permissionBatchRequestIds')`,
                    ),
                  ),
              )
            : undefined,
          notExists(
            db
              .select({ id: claimed.id })
              .from(claimed)
              .where(
                and(
                  eq(claimed.appId, input.claim.scope.appId),
                  eq(claimed.kind, 'permission'),
                  sql`${claimed.payloadJson} #>> '{permissionCallbackClaim,scope,appId}' = ${input.claim.scope.appId}`,
                  sql`${claimed.payloadJson} #>> '{permissionCallbackClaim,scope,sourceAgentFolder}' = ${input.claim.scope.sourceAgentFolder}`,
                  sql`${claimed.payloadJson} #>> '{permissionCallbackClaim,scope,interactionId}' = ${input.claim.scope.interactionId}`,
                ),
              ),
          ),
        )
      : undefined;
  const claimedPayload = sql`(
    ${table.payloadJson} - 'permissionBatchCallbackId' - 'permissionCallbackId'
  ) || jsonb_build_object(
    'permissionCallbackClaim',
    (${claim}::jsonb - 'match') || jsonb_build_object(
      'match',
      (${claim}::jsonb -> 'match') || jsonb_build_object(
        'providerAliases',
        CASE
          WHEN jsonb_typeof(${table.payloadJson} -> 'permissionCallbackId') = 'string'
            THEN jsonb_build_array(${table.payloadJson} -> 'permissionCallbackId')
          ELSE '[]'::jsonb
        END
      )
    )
  )`;
  const rows = await db
    .update(table)
    .set({
      payloadJson: claimedPayload,
    })
    .where(
      and(
        eq(table.appId, input.claim.scope.appId),
        eq(table.kind, 'permission'),
        eq(table.status, 'pending'),
        sql`${table.expiresAt} > ${input.claim.intent.decidedAt}`,
        sql`COALESCE(
          ${table.payloadJson} ->> 'sourceAgentFolder',
          ${table.payloadJson} #>> '{request,sourceAgentFolder}'
        ) = ${input.claim.scope.sourceAgentFolder}`,
        sql`NOT (${table.payloadJson} ? 'permissionCallbackClaim')`,
        input.claim.match.kind === 'batch'
          ? and(
              sql`${table.payloadJson} ->> 'permissionBatchCallbackId' = ${input.claim.scope.interactionId}`,
              sql`jsonb_typeof(${table.payloadJson} -> 'permissionBatchRequestIds') = 'array'`,
              sql`(${table.payloadJson} -> 'permissionBatchRequestIds') ? (${table.payloadJson} ->> 'requestId')`,
              batchClaimGuard,
            )
          : and(
              input.claim.match.providerAliases[0]
                ? sql`${table.payloadJson} ->> 'permissionCallbackId' = ${input.claim.match.providerAliases[0]}`
                : undefined,
              sql`${table.payloadJson} ->> 'requestId' = ${input.claim.scope.interactionId}
                AND NOT (${table.payloadJson} ? 'permissionBatchCallbackId')`,
            ),
      ),
    )
    .returning();
  return rows.map(toPendingInteraction);
}

export async function releasePendingPermissionCallbackRows(
  db: CanonicalDb,
  input: { claim: PermissionCallbackClaimReference },
): Promise<number> {
  const table = pgSchema.pendingInteractionsPostgres;
  const storedClaim = sql`${table.payloadJson} -> 'permissionCallbackClaim'`;
  const rows = await db
    .update(table)
    .set({
      payloadJson: sql`(
        CASE
          WHEN ${storedClaim} #>> '{match,kind}' = 'batch'
            THEN (${table.payloadJson} - 'permissionCallbackClaim')
              || jsonb_build_object(
                'permissionBatchCallbackId',
                ${storedClaim} #>> '{match,canonicalId}'
              )
          ELSE ${table.payloadJson} - 'permissionCallbackClaim'
        END
      ) || CASE
        WHEN jsonb_array_length(COALESCE(${storedClaim} #> '{match,providerAliases}', '[]'::jsonb)) > 0
          THEN jsonb_build_object(
            'permissionCallbackId',
            ${storedClaim} #>> '{match,providerAliases,0}'
          )
        ELSE '{}'::jsonb
      END`,
    })
    .where(scopedClaimWhere(table, input.claim))
    .returning({ id: table.id });
  return rows.length;
}

export async function settlePendingPermissionCallbackRows(
  db: CanonicalDb,
  input: { claim: PermissionCallbackClaimReference },
): Promise<number> {
  const table = pgSchema.pendingInteractionsPostgres;
  const rows = await db
    .update(table)
    .set({
      payloadJson: sql`(${table.payloadJson} - 'permissionCallbackClaim')
        || jsonb_build_object(
          'permissionCallbackSettlement',
          (${table.payloadJson} -> 'permissionCallbackClaim')
            || jsonb_build_object('settledAt', CURRENT_TIMESTAMP::text)
        )`,
    })
    .where(scopedClaimWhere(table, input.claim))
    .returning({ id: table.id });
  return rows.length;
}

export async function expirePendingPermissionReviewEachRows(
  db: CanonicalDb,
  input: { claim: PermissionCallbackClaimReference; now: string },
): Promise<PendingInteraction[]> {
  const table = pgSchema.pendingInteractionsPostgres;
  const activeClaim = sql`${table.payloadJson} -> 'permissionCallbackClaim'`;
  const settlement = sql`${table.payloadJson} -> 'permissionCallbackSettlement'`;
  const owner = sql`CASE
    WHEN ${activeClaim} #>> '{id}' = ${input.claim.id}
      THEN ${activeClaim}
    ELSE ${settlement}
  END`;
  const rows = await db
    .update(table)
    .set({
      payloadJson: sql`(
        ${table.payloadJson}
          - 'permissionCallbackClaim'
          - 'permissionCallbackSettlement'
          - 'permissionBatchCallbackId'
          - 'permissionCallbackId'
      ) || jsonb_build_object(
        'permissionCallbackClaim',
        CASE
          WHEN ${activeClaim} #>> '{id}' = ${input.claim.id}
            THEN (${owner} - 'settledAt') || jsonb_build_object(
              'intent',
              (${owner} -> 'intent') || jsonb_build_object(
                'mode', 'cancel',
                'approverRef', 'system',
                'decidedAt', ${input.now}::text
              )
            )
          ELSE jsonb_build_object(
            'id', (${owner} ->> 'id') || ':expired:' || (${table.payloadJson} ->> 'requestId'),
            'scope', jsonb_build_object(
              'appId', ${input.claim.scope.appId}::text,
              'sourceAgentFolder', ${input.claim.scope.sourceAgentFolder}::text,
              'interactionId', ${table.payloadJson} ->> 'requestId'
            ),
            'intent', jsonb_build_object(
              'mode', 'cancel',
              'approverRef', 'system',
              'decidedAt', ${input.now}::text
            ),
            'match', jsonb_build_object(
              'kind', 'individual',
              'canonicalId', ${table.payloadJson} ->> 'requestId',
              'providerAliases', COALESCE(
                ${owner} #> '{match,providerAliases}',
                '[]'::jsonb
              )
            )
          )
        END
      )`,
    })
    .where(
      and(
        eq(table.appId, input.claim.scope.appId),
        eq(table.kind, 'permission'),
        eq(table.status, 'pending'),
        sql`COALESCE(
          ${table.payloadJson} ->> 'sourceAgentFolder',
          ${table.payloadJson} #>> '{request,sourceAgentFolder}'
        ) = ${input.claim.scope.sourceAgentFolder}`,
        sql`${owner} #>> '{id}' = ${input.claim.id}`,
        sql`${owner} #>> '{scope,appId}' = ${input.claim.scope.appId}`,
        sql`${owner} #>> '{scope,sourceAgentFolder}' = ${input.claim.scope.sourceAgentFolder}`,
        sql`${owner} #>> '{scope,interactionId}' = ${input.claim.scope.interactionId}`,
        sql`${owner} #>> '{match,kind}' = 'batch'`,
        sql`${owner} #>> '{intent,mode}' = 'allow_persistent_rule'`,
        or(
          sql`NOT (${table.payloadJson} ? 'permissionCallbackClaim')`,
          and(
            sql`${activeClaim} #>> '{id}' = ${input.claim.id}`,
            sql`${activeClaim} #>> '{scope,interactionId}' = ${input.claim.scope.interactionId}`,
          ),
        ),
      ),
    )
    .returning();
  return rows.map(toPendingInteraction);
}

export async function findPendingPermissionInteractionRows(
  db: CanonicalDb,
  input: {
    scope: PermissionCallbackScope;
    now: string;
    includeTerminalSettlement?: boolean;
  },
): Promise<PendingInteraction[]> {
  const table = pgSchema.pendingInteractionsPostgres;
  const pendingMatch = and(
    eq(table.status, 'pending'),
    sql`${table.expiresAt} > ${input.now}`,
    sql`(
      (
        NOT (${table.payloadJson} ? 'permissionCallbackClaim')
        AND (
          ${table.payloadJson} ->> 'requestId' = ${input.scope.interactionId}
          OR ${table.payloadJson} ->> 'permissionBatchCallbackId' = ${input.scope.interactionId}
        )
      )
      OR (
        ${table.payloadJson} #>> '{permissionCallbackClaim,scope,interactionId}' = ${input.scope.interactionId}
        AND ${table.payloadJson} #>> '{permissionCallbackClaim,scope,appId}' = ${input.scope.appId}
        AND ${table.payloadJson} #>> '{permissionCallbackClaim,scope,sourceAgentFolder}' = ${input.scope.sourceAgentFolder}
      )
      OR ${table.payloadJson} #>> '{permissionRecoveryEnvelope,batch,canonicalId}' = ${input.scope.interactionId}
    )`,
  );
  const terminalSettlementMatch = sql`
    ${table.payloadJson} #>> '{permissionCallbackSettlement,scope,interactionId}' = ${input.scope.interactionId}
    AND ${table.payloadJson} #>> '{permissionCallbackSettlement,scope,appId}' = ${input.scope.appId}
    AND ${table.payloadJson} #>> '{permissionCallbackSettlement,scope,sourceAgentFolder}' = ${input.scope.sourceAgentFolder}
  `;
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.appId, input.scope.appId),
        eq(table.kind, 'permission'),
        sql`COALESCE(
          ${table.payloadJson} ->> 'sourceAgentFolder',
          ${table.payloadJson} #>> '{request,sourceAgentFolder}'
        ) = ${input.scope.sourceAgentFolder}`,
        input.includeTerminalSettlement
          ? or(pendingMatch, terminalSettlementMatch)
          : pendingMatch,
      ),
    );
  return rows.map(toPendingInteraction);
}

function scopedClaimWhere(
  table: typeof pgSchema.pendingInteractionsPostgres,
  claim: PermissionCallbackClaimReference,
) {
  return and(
    eq(table.appId, claim.scope.appId),
    eq(table.kind, 'permission'),
    eq(table.status, 'pending'),
    sql`COALESCE(
      ${table.payloadJson} ->> 'sourceAgentFolder',
      ${table.payloadJson} #>> '{request,sourceAgentFolder}'
    ) = ${claim.scope.sourceAgentFolder}`,
    sql`${table.payloadJson} #>> '{permissionCallbackClaim,id}' = ${claim.id}`,
    sql`${table.payloadJson} #>> '{permissionCallbackClaim,scope,interactionId}' = ${claim.scope.interactionId}`,
    sql`${table.payloadJson} #>> '{permissionCallbackClaim,scope,appId}' = ${claim.scope.appId}`,
    sql`${table.payloadJson} #>> '{permissionCallbackClaim,scope,sourceAgentFolder}' = ${claim.scope.sourceAgentFolder}`,
  );
}
