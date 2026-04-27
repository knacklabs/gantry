import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

import type { Agent } from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type {
  Conversation,
  ConversationThread,
} from '../../../../domain/conversation/conversation.js';
import type {
  AgentSessionRepository,
  AgentSessionSummaryRepository,
  ProviderSessionRepository,
} from '../../../../domain/ports/repositories.js';
import type {
  AgentSession,
  AgentSessionSummary,
  ProviderSession,
} from '../../../../domain/sessions/sessions.js';
import type { ExternalRef } from '../../../../shared/ids/branded-id.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

type JsonRecord = Record<string, unknown>;

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return fallback;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === '23505'
  );
}

function externalRef<Kind extends string>(
  value: unknown,
  fallbackKind: Kind,
  fallbackValue?: string | null,
): ExternalRef<Kind> | undefined {
  const parsed = parseJson<Partial<ExternalRef<Kind>> & JsonRecord>(value, {});
  if (typeof parsed.kind === 'string' && typeof parsed.value === 'string') {
    return { kind: parsed.kind as Kind, value: parsed.value };
  }
  return fallbackValue
    ? { kind: fallbackKind, value: fallbackValue }
    : undefined;
}

function providerFromProviderRef(ref: ExternalRef<'provider_session'>): string {
  const idx = ref.value.indexOf(':');
  if (idx <= 0) {
    throw new Error(
      `Provider session ref must be prefixed as "<provider>:<external-session-id>"; received ${ref.value}`,
    );
  }
  return ref.value.slice(0, idx);
}

function externalSessionIdFromProviderRef(
  ref: ExternalRef<'provider_session'>,
): string {
  const idx = ref.value.indexOf(':');
  return idx > 0 ? ref.value.slice(idx + 1) : ref.value;
}

export class PostgresAgentSessionRepository implements AgentSessionRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getAgentSession(id: AgentSession['id']): Promise<AgentSession | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentSessionsPostgres)
      .where(eq(pgSchema.agentSessionsPostgres.id, id))
      .limit(1);
    return rows[0] ? this.sessionFromRow(rows[0]) : null;
  }

  async getAgentSessionByKey(input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
    userId?: string;
  }): Promise<AgentSession | null> {
    const s = pgSchema.agentSessionsPostgres;
    const rows = await this.db
      .select()
      .from(s)
      .where(
        and(
          eq(s.appId, input.appId),
          eq(s.agentId, input.agentId),
          eq(s.conversationId, input.conversationId),
          input.threadId ? eq(s.threadId, input.threadId) : isNull(s.threadId),
          input.userId ? eq(s.userId, input.userId) : isNull(s.userId),
          isNull(s.jobId),
        ),
      )
      .orderBy(desc(s.updatedAt), desc(s.id))
      .limit(1);
    return rows[0] ? this.sessionFromRow(rows[0]) : null;
  }

  async saveAgentSession(session: AgentSession): Promise<void> {
    try {
      await this.writeAgentSession(session);
    } catch (err) {
      if (!isUniqueViolation(err) || !session.conversationId || session.jobId) {
        throw err;
      }
      const existing = await this.getAgentSessionByKey({
        appId: session.appId,
        agentId: session.agentId,
        conversationId: session.conversationId,
        threadId: session.threadId,
        userId: session.userId,
      });
      if (!existing) throw err;
      await this.writeAgentSession({ ...session, id: existing.id });
    }
  }

  private async writeAgentSession(session: AgentSession): Promise<void> {
    await this.db
      .insert(pgSchema.agentSessionsPostgres)
      .values({
        id: session.id,
        appId: session.appId,
        agentId: session.agentId,
        conversationId: session.conversationId ?? null,
        threadId: session.threadId ?? null,
        jobId: session.jobId ?? null,
        userId: session.userId ?? null,
        status: session.status,
        modelOverride: session.modelOverride ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        resetAt: session.resetAt ?? null,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentSessionsPostgres.id,
        set: {
          status: session.status,
          modelOverride: session.modelOverride ?? null,
          updatedAt: session.updatedAt,
          resetAt: session.resetAt ?? null,
        },
      });
  }

  private sessionFromRow(
    row: typeof pgSchema.agentSessionsPostgres.$inferSelect,
  ): AgentSession {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      conversationId: row.conversationId ?? undefined,
      threadId: row.threadId ?? undefined,
      jobId: row.jobId ?? undefined,
      userId: row.userId ?? undefined,
      status: row.status as AgentSession['status'],
      modelOverride: row.modelOverride ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resetAt: row.resetAt ?? undefined,
    } as AgentSession;
  }
}

export class PostgresProviderSessionRepository implements ProviderSessionRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getProviderSession(
    id: ProviderSession['id'],
  ): Promise<ProviderSession | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.providerSessionsPostgres)
      .where(eq(pgSchema.providerSessionsPostgres.id, id))
      .limit(1);
    return rows[0] ? this.providerSessionFromRow(rows[0]) : null;
  }

  async getLatestProviderSession(input: {
    agentSessionId: AgentSession['id'];
    provider?: string;
  }): Promise<ProviderSession | null> {
    const ps = pgSchema.providerSessionsPostgres;
    const rows = await this.db
      .select()
      .from(ps)
      .where(
        and(
          eq(ps.agentSessionId, input.agentSessionId),
          eq(ps.status, 'active'),
          input.provider ? eq(ps.provider, input.provider) : undefined,
        ),
      )
      .orderBy(desc(ps.updatedAt), desc(ps.createdAt), desc(ps.id))
      .limit(1);
    return rows[0] ? this.providerSessionFromRow(rows[0]) : null;
  }

  async saveProviderSession(session: ProviderSession): Promise<void> {
    const provider =
      session.provider || providerFromProviderRef(session.providerRef);
    const externalSessionId =
      session.externalSessionId ||
      externalSessionIdFromProviderRef(session.providerRef);
    const artifactRef = session.artifactRef ?? null;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(pgSchema.providerSessionsPostgres)
        .values({
          id: session.id,
          appId: session.appId,
          agentSessionId: session.agentSessionId,
          provider,
          externalSessionId,
          artifactRef,
          providerRefJson: encodeJson(session.providerRef),
          metadataJson: encodeJson(session.metadata ?? {}),
          status: session.status,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        })
        .onConflictDoUpdate({
          target: pgSchema.providerSessionsPostgres.id,
          set: {
            provider,
            externalSessionId,
            artifactRef,
            providerRefJson: encodeJson(session.providerRef),
            metadataJson: encodeJson(session.metadata ?? {}),
            status: session.status,
            updatedAt: session.updatedAt,
          },
        });
      await tx
        .update(pgSchema.agentSessionsPostgres)
        .set({
          latestProviderSessionId: session.id,
          updatedAt: session.updatedAt,
        })
        .where(
          and(
            eq(pgSchema.agentSessionsPostgres.id, session.agentSessionId),
            or(
              isNull(pgSchema.agentSessionsPostgres.latestProviderSessionId),
              sql`NOT EXISTS (
                SELECT 1
                FROM ${pgSchema.providerSessionsPostgres} latest
                WHERE latest.id = ${pgSchema.agentSessionsPostgres.latestProviderSessionId}
                  AND latest.updated_at > ${session.updatedAt}
              )`,
            ),
          ),
        );
    });
  }

  async markProviderSessionStatus(
    id: ProviderSession['id'],
    status: ProviderSession['status'],
    updatedAt: string,
  ): Promise<void> {
    await this.db
      .update(pgSchema.providerSessionsPostgres)
      .set({ status, updatedAt })
      .where(eq(pgSchema.providerSessionsPostgres.id, id));
  }

  private providerSessionFromRow(
    row: typeof pgSchema.providerSessionsPostgres.$inferSelect,
  ): ProviderSession {
    return {
      id: row.id,
      appId: row.appId,
      agentSessionId: row.agentSessionId,
      provider: row.provider,
      externalSessionId: row.externalSessionId,
      artifactRef: row.artifactRef ?? undefined,
      providerRef:
        externalRef(
          row.providerRefJson,
          'provider_session',
          `${row.provider}:${row.externalSessionId}`,
        ) ??
        ({
          kind: 'provider_session',
          value: `${row.provider}:${row.externalSessionId}`,
        } as const),
      metadata: parseJson(row.metadataJson, {}),
      status: row.status as ProviderSession['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as ProviderSession;
  }
}

export class PostgresAgentSessionSummaryRepository implements AgentSessionSummaryRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getAgentSessionSummary(
    id: AgentSessionSummary['id'],
  ): Promise<AgentSessionSummary | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentSessionSummariesPostgres)
      .where(eq(pgSchema.agentSessionSummariesPostgres.id, id))
      .limit(1);
    return rows[0] ? this.summaryFromRow(rows[0]) : null;
  }

  async getLatestAgentSessionSummary(
    agentSessionId: AgentSession['id'],
  ): Promise<AgentSessionSummary | null> {
    const s = pgSchema.agentSessionSummariesPostgres;
    const rows = await this.db
      .select()
      .from(s)
      .where(eq(s.agentSessionId, agentSessionId))
      .orderBy(desc(s.createdAt), desc(s.id))
      .limit(1);
    return rows[0] ? this.summaryFromRow(rows[0]) : null;
  }

  async saveAgentSessionSummary(summary: AgentSessionSummary): Promise<void> {
    await this.db
      .insert(pgSchema.agentSessionSummariesPostgres)
      .values({
        id: summary.id,
        appId: summary.appId,
        agentSessionId: summary.agentSessionId,
        summary: summary.summary,
        source: summary.source,
        fromMessageId: summary.fromMessageId ?? null,
        toMessageId: summary.toMessageId ?? null,
        fromRunId: summary.fromRunId ?? null,
        toRunId: summary.toRunId ?? null,
        messageCount: summary.messageCount,
        runCount: summary.runCount,
        createdAt: summary.createdAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentSessionSummariesPostgres.id,
        set: {
          summary: summary.summary,
          source: summary.source,
          fromMessageId: summary.fromMessageId ?? null,
          toMessageId: summary.toMessageId ?? null,
          fromRunId: summary.fromRunId ?? null,
          toRunId: summary.toRunId ?? null,
          messageCount: summary.messageCount,
          runCount: summary.runCount,
        },
      });
  }

  private summaryFromRow(
    row: typeof pgSchema.agentSessionSummariesPostgres.$inferSelect,
  ): AgentSessionSummary {
    return {
      id: row.id,
      appId: row.appId,
      agentSessionId: row.agentSessionId,
      summary: row.summary,
      source: row.source as AgentSessionSummary['source'],
      fromMessageId: row.fromMessageId ?? undefined,
      toMessageId: row.toMessageId ?? undefined,
      fromRunId: row.fromRunId ?? undefined,
      toRunId: row.toRunId ?? undefined,
      messageCount: row.messageCount,
      runCount: row.runCount,
      createdAt: row.createdAt,
    } as AgentSessionSummary;
  }
}
