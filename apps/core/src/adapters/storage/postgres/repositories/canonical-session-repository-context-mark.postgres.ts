import { and, eq, inArray, or, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  conversationIdForJid,
  threadIdFor,
  type CanonicalDb,
  type CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import {
  buildCurrentScopeResetMatcher,
  findControlSessionForChatJid,
  RESUMABLE_PROVIDER_SESSION_STATUSES,
  resolveSessionAppId,
} from './canonical-session-repository-helpers.postgres.js';
import {
  normalizeProviderSessionContextHighWaterMark,
  type RetiredProviderSessionReference,
} from '../../../../domain/sessions/provider-session-measurement.js';
import type { ExecutionProviderId } from '../../../../domain/sessions/sessions.js';

export type ProviderSessionContextHighWaterMarkInput = {
  providerSessionId: string;
  agentSessionId: string;
  provider: ExecutionProviderId;
  externalSessionId: string;
  expectedAgentSessionResetAt: string | null;
  contextHighWaterMark: number;
};

export type RetireProviderSessionInput = Omit<
  ProviderSessionContextHighWaterMarkInput,
  'contextHighWaterMark'
>;

export type ResetScopeInput = {
  appId?: string;
  scopeKey: string;
  chatJid?: string;
  threadId?: string | null;
  agentId?: string;
};

function providerSessionGenerationFence(input: {
  agentSessionId: string;
  expectedAgentSessionResetAt: string | null;
}) {
  return sql`EXISTS (
    SELECT 1
    FROM ${pgSchema.agentSessionsPostgres}
    WHERE ${pgSchema.agentSessionsPostgres.id} = ${input.agentSessionId}
      AND ${pgSchema.agentSessionsPostgres.resetAt} IS NOT DISTINCT FROM ${input.expectedAgentSessionResetAt}
  )`;
}

export async function raiseProviderSessionContextHighWaterMark(
  executor: CanonicalExecutor,
  input: ProviderSessionContextHighWaterMarkInput,
): Promise<boolean> {
  const contextHighWaterMark = normalizeProviderSessionContextHighWaterMark(
    input.contextHighWaterMark,
  );
  const result = await executor
    .update(pgSchema.providerSessionsPostgres)
    .set({
      contextHighWaterMark,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(pgSchema.providerSessionsPostgres.id, input.providerSessionId),
        eq(
          pgSchema.providerSessionsPostgres.agentSessionId,
          input.agentSessionId,
        ),
        eq(pgSchema.providerSessionsPostgres.provider, input.provider),
        eq(
          pgSchema.providerSessionsPostgres.externalSessionId,
          input.externalSessionId,
        ),
        inArray(
          pgSchema.providerSessionsPostgres.status,
          RESUMABLE_PROVIDER_SESSION_STATUSES,
        ),
        sql`(${pgSchema.providerSessionsPostgres.contextHighWaterMark} IS NULL OR ${pgSchema.providerSessionsPostgres.contextHighWaterMark} < ${contextHighWaterMark})`,
        providerSessionGenerationFence(input),
      ),
    );
  return Number(result.rowCount ?? 0) > 0;
}

export async function retireProviderSession(
  executor: CanonicalExecutor,
  input: RetireProviderSessionInput,
): Promise<RetiredProviderSessionReference | undefined> {
  const [retired] = await executor
    .update(pgSchema.providerSessionsPostgres)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(
      and(
        eq(pgSchema.providerSessionsPostgres.id, input.providerSessionId),
        eq(
          pgSchema.providerSessionsPostgres.agentSessionId,
          input.agentSessionId,
        ),
        eq(pgSchema.providerSessionsPostgres.provider, input.provider),
        eq(
          pgSchema.providerSessionsPostgres.externalSessionId,
          input.externalSessionId,
        ),
        eq(pgSchema.providerSessionsPostgres.status, 'active'),
        providerSessionGenerationFence(input),
      ),
    )
    .returning({
      providerSessionId: pgSchema.providerSessionsPostgres.id,
      externalSessionId: pgSchema.providerSessionsPostgres.externalSessionId,
      executionProviderId: pgSchema.providerSessionsPostgres.provider,
    });
  return retired as RetiredProviderSessionReference | undefined;
}

export async function resetProviderSessionScope(
  db: CanonicalDb,
  input: ResetScopeInput,
  findBoundAgentId: (
    input: {
      appId: string;
      conversationId: string;
      threadId: string | null;
      agentId?: string;
    },
    executor: CanonicalExecutor,
  ) => Promise<string | undefined>,
): Promise<readonly RetiredProviderSessionReference[]> {
  const matcher = buildCurrentScopeResetMatcher(input.scopeKey);
  const predicates = [
    eq(pgSchema.agentSessionsPostgres.scopeKey, matcher.currentScopeExact),
  ];
  if (matcher.currentScopeDescendantLike) {
    predicates.push(
      sql`${pgSchema.agentSessionsPostgres.scopeKey} LIKE ${matcher.currentScopeDescendantLike} ESCAPE '\\'`,
    );
  }
  const appId = resolveSessionAppId({
    appId: input.appId,
    chatJid: input.chatJid,
  });
  return db.transaction(async (tx) => {
    let ownerAgentId = input.agentId?.trim() || undefined;
    if (!ownerAgentId && input.chatJid) {
      ownerAgentId =
        appId === CANONICAL_APP_ID
          ? await findBoundAgentId(
              {
                appId,
                conversationId: conversationIdForJid(input.chatJid),
                threadId: threadIdFor(input.chatJid, input.threadId),
              },
              tx,
            )
          : (await findControlSessionForChatJid(tx, appId, input.chatJid))
              ?.agentId;
    }
    const rows = await tx
      .select({ id: pgSchema.agentSessionsPostgres.id })
      .from(pgSchema.agentSessionsPostgres)
      .where(
        and(
          eq(pgSchema.agentSessionsPostgres.appId, appId),
          or(...predicates),
          ...(ownerAgentId
            ? [eq(pgSchema.agentSessionsPostgres.agentId, ownerAgentId)]
            : []),
        ),
      )
      .for('update');
    const sessionIds = rows.map((row) => row.id);
    if (sessionIds.length === 0) return Object.freeze([]);
    const retired = await tx
      .select({
        providerSessionId: pgSchema.providerSessionsPostgres.id,
        externalSessionId: pgSchema.providerSessionsPostgres.externalSessionId,
        executionProviderId: pgSchema.providerSessionsPostgres.provider,
      })
      .from(pgSchema.providerSessionsPostgres)
      .where(
        inArray(pgSchema.providerSessionsPostgres.agentSessionId, sessionIds),
      )
      .for('update');
    await tx
      .delete(pgSchema.providerSessionsPostgres)
      .where(
        inArray(pgSchema.providerSessionsPostgres.agentSessionId, sessionIds),
      );
    await tx
      .update(pgSchema.agentSessionsPostgres)
      .set({
        latestProviderSessionId: null,
        status: 'active',
        resetAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(inArray(pgSchema.agentSessionsPostgres.id, sessionIds));
    return Object.freeze(
      retired.map((reference) => ({
        ...reference,
        executionProviderId:
          reference.executionProviderId as ExecutionProviderId,
      })),
    ) as readonly RetiredProviderSessionReference[];
  });
}
