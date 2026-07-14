import { and, eq, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
import {
  CANONICAL_APP_ID,
  jsonb,
} from './canonical-graph-repository.postgres.js';
import { appIdFromConversationJid } from '../../../../shared/app-conversation-jid.js';

export const RESUMABLE_PROVIDER_SESSION_STATUSES = [
  'active',
  'maintenance_compact',
  'ready',
];
const MAINTENANCE_COMPACT_STALE_LOCK_SQL = sql`now() - interval '10 minutes'`;

export type ProviderSessionMaintenanceInput = {
  providerSessionId: string;
  agentSessionId: string;
  provider: string;
  externalSessionId: string;
  compactionBaseCursor?: string | null;
};

export type ProviderSessionMaintenanceFinishInput =
  ProviderSessionMaintenanceInput & {
    status: 'active' | 'expired' | 'ready';
  };

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function makeOwnedAgentSessionScopeKey(
  agentId: string,
  routeScopeKey: string,
  appId = CANONICAL_APP_ID,
): string {
  const agentScope = `agent:${encodeURIComponent(agentId)}::${routeScopeKey}`;
  if (appId === CANONICAL_APP_ID) return agentScope;
  return `app:${encodeURIComponent(appId)}::${agentScope}`;
}

export function makeOwnedAgentSessionId(
  agentId: string,
  routeScopeKey: string,
  appId = CANONICAL_APP_ID,
): string {
  return `agent-session:${makeOwnedAgentSessionScopeKey(agentId, routeScopeKey, appId)}`;
}

function isScopedSessionKey(scopeKey: string): boolean {
  return /::(?:conversation|user|thread):/.test(scopeKey);
}

export function buildCurrentScopeResetMatcher(scopeKey: string): {
  currentScopeExact: string;
  currentScopeDescendantLike?: string;
} {
  const escapedScopeKey = escapeLikePattern(scopeKey);
  const includeDescendants = !isScopedSessionKey(scopeKey);
  return {
    currentScopeExact: scopeKey,
    ...(includeDescendants
      ? {
          currentScopeDescendantLike: `${escapedScopeKey}::%`,
        }
      : {}),
  };
}

export function conversationKindInput(kind?: 'dm' | 'channel'): {
  isGroup?: boolean;
} {
  if (kind === 'channel') return { isGroup: true };
  if (kind === 'dm') return { isGroup: false };
  return {};
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringMetadataValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function compactionDeltaReplay(metadata: Record<string, unknown>):
  | {
      status: 'pending' | 'applied' | 'degraded';
      baseCursor?: string;
      lockedAt?: string;
    }
  | undefined {
  const raw = metadata.deltaReplay;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const replay = raw as Record<string, unknown>;
  const status = replay.status;
  if (status !== 'pending' && status !== 'applied' && status !== 'degraded') {
    return undefined;
  }
  return {
    status,
    ...(typeof replay.baseCursor === 'string'
      ? { baseCursor: replay.baseCursor }
      : {}),
    ...(typeof replay.lockedAt === 'string'
      ? { lockedAt: replay.lockedAt }
      : {}),
  };
}

export function providerSessionContext(providerSession: {
  id: string;
  externalSessionId: string;
  metadataJson: unknown;
  status?: string;
}): {
  providerSessionId?: string;
  externalSessionId?: string;
  latestProviderSessionLocked?: boolean;
  lockedProviderSessionId?: string;
  latestProviderSessionReady?: boolean;
  readyProviderSessionId?: string;
  readyExternalSessionId?: string;
  providerSessionAccessFingerprint?: string;
  compactionDeltaReplay?: {
    status: 'pending' | 'applied' | 'degraded';
    baseCursor?: string;
    lockedAt?: string;
  };
} {
  const metadata = parseJsonRecord(providerSession.metadataJson);
  const deltaReplay = compactionDeltaReplay(metadata);
  if (providerSession.status === 'maintenance_compact') {
    return {
      latestProviderSessionLocked: true,
      lockedProviderSessionId: providerSession.id,
      ...(deltaReplay ? { compactionDeltaReplay: deltaReplay } : {}),
    };
  }
  if (providerSession.status === 'ready') {
    const accessFingerprint = stringMetadataValue(
      metadata,
      'accessFingerprint',
    );
    return {
      latestProviderSessionReady: true,
      readyProviderSessionId: providerSession.id,
      readyExternalSessionId: providerSession.externalSessionId,
      ...(accessFingerprint
        ? { providerSessionAccessFingerprint: accessFingerprint }
        : {}),
      ...(deltaReplay ? { compactionDeltaReplay: deltaReplay } : {}),
    };
  }
  const accessFingerprint = stringMetadataValue(metadata, 'accessFingerprint');
  return {
    providerSessionId: providerSession.id,
    externalSessionId: providerSession.externalSessionId,
    ...(accessFingerprint
      ? { providerSessionAccessFingerprint: accessFingerprint }
      : {}),
    ...(deltaReplay ? { compactionDeltaReplay: deltaReplay } : {}),
  };
}

export async function isProviderSessionMaintenanceLocked(
  executor: CanonicalExecutor,
  id: string,
): Promise<boolean> {
  await releaseStaleProviderSessionMaintenanceLocks(executor, {
    providerSessionId: id,
  });
  const [locked] = await executor
    .select({ id: pgSchema.providerSessionsPostgres.id })
    .from(pgSchema.providerSessionsPostgres)
    .where(
      and(
        eq(pgSchema.providerSessionsPostgres.id, id),
        eq(pgSchema.providerSessionsPostgres.status, 'maintenance_compact'),
      ),
    )
    .for('update')
    .limit(1);
  return Boolean(locked);
}

export async function releaseStaleProviderSessionMaintenanceLocks(
  executor: CanonicalExecutor,
  input: {
    providerSessionId?: string;
    agentSessionId?: string;
    provider?: string;
  },
): Promise<void> {
  await executor
    .update(pgSchema.providerSessionsPostgres)
    .set({ status: 'active', updatedAt: sql`now()` })
    .where(
      and(
        input.providerSessionId
          ? eq(pgSchema.providerSessionsPostgres.id, input.providerSessionId)
          : undefined,
        input.agentSessionId
          ? eq(
              pgSchema.providerSessionsPostgres.agentSessionId,
              input.agentSessionId,
            )
          : undefined,
        input.provider
          ? eq(pgSchema.providerSessionsPostgres.provider, input.provider)
          : undefined,
        eq(pgSchema.providerSessionsPostgres.status, 'maintenance_compact'),
        sql`${pgSchema.providerSessionsPostgres.updatedAt} < ${MAINTENANCE_COMPACT_STALE_LOCK_SQL}`,
        sql`not exists (
          select 1 from ${pgSchema.agentAsyncTasksPostgres} task
          where task.kind = 'session_compaction'
            and task.status in ('queued', 'running')
            and task.private_correlation_json->>'providerSessionId' = ${pgSchema.providerSessionsPostgres.id}
            and coalesce(task.heartbeat_at, task.updated_at) >= ${MAINTENANCE_COMPACT_STALE_LOCK_SQL}
        )`,
      ),
    );
}

export async function markLatestProviderSessionMaintenance(
  executor: CanonicalExecutor,
  input: ProviderSessionMaintenanceInput,
): Promise<boolean> {
  const lockedAt = new Date().toISOString();
  const result = await executor
    .update(pgSchema.providerSessionsPostgres)
    .set({
      status: 'maintenance_compact',
      metadataJson: sql`${pgSchema.providerSessionsPostgres.metadataJson} || ${jsonb(
        {
          deltaReplay: {
            status: 'pending',
            baseCursor: input.compactionBaseCursor ?? null,
            lockedAt,
          },
        },
      )}`,
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
        eq(pgSchema.providerSessionsPostgres.status, 'active'),
        sql`EXISTS (
          SELECT 1 FROM ${pgSchema.agentSessionsPostgres} agent_session
          WHERE agent_session.id = ${input.agentSessionId}
            AND agent_session.latest_provider_session_id = ${input.providerSessionId}
        )`,
      ),
    );
  return Number(result.rowCount ?? 0) > 0;
}

export async function finishProviderSessionMaintenance(
  executor: CanonicalExecutor,
  input: ProviderSessionMaintenanceFinishInput,
): Promise<void> {
  const metadataPatch =
    input.status === 'ready'
      ? jsonb({
          compactionPromotion: 'pending_next_turn',
        })
      : undefined;
  const result = await executor
    .update(pgSchema.providerSessionsPostgres)
    .set({
      status: input.status,
      ...(metadataPatch
        ? {
            metadataJson: sql`${pgSchema.providerSessionsPostgres.metadataJson} || ${metadataPatch}`,
          }
        : {}),
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
        eq(pgSchema.providerSessionsPostgres.status, 'maintenance_compact'),
      ),
    );
  if (Number(result.rowCount ?? 0) === 0 || input.status !== 'active') return;
  await executor
    .update(pgSchema.agentSessionsPostgres)
    .set({
      latestProviderSessionId: input.providerSessionId,
      updatedAt: sql`now()`,
    })
    .where(eq(pgSchema.agentSessionsPostgres.id, input.agentSessionId));
}

export async function promoteReadyProviderSession(
  executor: CanonicalExecutor,
  input: ProviderSessionMaintenanceInput,
): Promise<boolean> {
  const result = await executor
    .update(pgSchema.providerSessionsPostgres)
    .set({
      status: 'active',
      metadataJson: sql`${pgSchema.providerSessionsPostgres.metadataJson} || ${jsonb(
        {
          compactionPromotion: 'promoted_next_turn',
        },
      )}`,
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
        eq(pgSchema.providerSessionsPostgres.status, 'ready'),
        sql`EXISTS (
          SELECT 1 FROM ${pgSchema.agentSessionsPostgres} agent_session
          WHERE agent_session.id = ${input.agentSessionId}
            AND agent_session.latest_provider_session_id = ${input.providerSessionId}
        )`,
      ),
    );
  if (Number(result.rowCount ?? 0) === 0) return false;
  await executor
    .update(pgSchema.agentSessionsPostgres)
    .set({
      latestProviderSessionId: input.providerSessionId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(pgSchema.agentSessionsPostgres.id, input.agentSessionId),
        eq(
          pgSchema.agentSessionsPostgres.latestProviderSessionId,
          input.providerSessionId,
        ),
      ),
    );
  return true;
}

export async function markProviderSessionDeltaReplay(
  executor: CanonicalExecutor,
  input: ProviderSessionMaintenanceInput & {
    status: 'applied' | 'degraded';
    reason?: string;
  },
): Promise<void> {
  await executor
    .update(pgSchema.providerSessionsPostgres)
    .set({
      metadataJson: sql`${pgSchema.providerSessionsPostgres.metadataJson} || ${jsonb(
        {
          deltaReplay: {
            status: input.status,
            ...(input.compactionBaseCursor
              ? { baseCursor: input.compactionBaseCursor }
              : {}),
            ...(input.reason ? { reason: input.reason } : {}),
            updatedAt: new Date().toISOString(),
          },
        },
      )}`,
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
      ),
    );
}

export async function promoteLatestReadyProviderSession(
  executor: CanonicalExecutor,
  input: {
    agentSessionId: string;
    provider: string;
  },
): Promise<boolean> {
  const [ready] = await executor
    .select({
      id: pgSchema.providerSessionsPostgres.id,
      externalSessionId: pgSchema.providerSessionsPostgres.externalSessionId,
    })
    .from(pgSchema.providerSessionsPostgres)
    .where(
      and(
        eq(
          pgSchema.providerSessionsPostgres.agentSessionId,
          input.agentSessionId,
        ),
        eq(pgSchema.providerSessionsPostgres.provider, input.provider),
        eq(pgSchema.providerSessionsPostgres.status, 'ready'),
        sql`EXISTS (
          SELECT 1 FROM ${pgSchema.agentSessionsPostgres} agent_session
          WHERE agent_session.id = ${input.agentSessionId}
            AND agent_session.latest_provider_session_id = ${pgSchema.providerSessionsPostgres.id}
        )`,
      ),
    )
    .orderBy(sql`${pgSchema.providerSessionsPostgres.updatedAt} DESC`)
    .limit(1);
  if (!ready) return false;
  return promoteReadyProviderSession(executor, {
    providerSessionId: ready.id,
    agentSessionId: input.agentSessionId,
    provider: input.provider,
    externalSessionId: ready.externalSessionId,
  });
}

export async function expireProviderSession(
  executor: CanonicalExecutor,
  input: ProviderSessionMaintenanceInput,
): Promise<void> {
  const providerSessionId = input.providerSessionId.trim();
  const agentSessionId = input.agentSessionId.trim();
  const provider = input.provider.trim();
  const externalSessionId = input.externalSessionId.trim();
  if (!providerSessionId || !agentSessionId || !provider || !externalSessionId)
    return;
  await executor
    .update(pgSchema.providerSessionsPostgres)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(
      and(
        eq(pgSchema.providerSessionsPostgres.id, providerSessionId),
        eq(pgSchema.providerSessionsPostgres.agentSessionId, agentSessionId),
        eq(pgSchema.providerSessionsPostgres.provider, provider),
        eq(
          pgSchema.providerSessionsPostgres.externalSessionId,
          externalSessionId,
        ),
      ),
    );
}

export async function findControlSessionForChatJid(
  executor: CanonicalExecutor,
  appId: string,
  chatJid: string,
): Promise<{ agentId: string; conversationId: string } | undefined> {
  const [session] = await executor
    .select({
      agentId: pgSchema.controlHttpSessionsPostgres.agentId,
      conversationId: pgSchema.controlHttpSessionsPostgres.conversationId,
    })
    .from(pgSchema.controlHttpSessionsPostgres)
    .where(
      and(
        eq(pgSchema.controlHttpSessionsPostgres.appId, appId),
        sql`${pgSchema.controlHttpSessionsPostgres.externalRefJson}->>'chatJid' = ${chatJid}`,
      ),
    )
    .limit(1);
  return session;
}

export function resolveSessionAppId(input: {
  appId?: string | null;
  chatJid?: string | null;
}): string {
  return (
    input.appId?.trim() ||
    (input.chatJid ? appIdFromConversationJid(input.chatJid) : null) ||
    CANONICAL_APP_ID
  );
}
