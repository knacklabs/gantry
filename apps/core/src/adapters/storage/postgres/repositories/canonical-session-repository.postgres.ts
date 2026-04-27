import { and, eq, ne, or, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  json,
  PostgresCanonicalGraphRepository,
  threadIdFor,
} from './canonical-graph-repository.postgres.js';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const PROVIDER = 'anthropic';

export class PostgresCanonicalSessionRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async getProviderSessionId(scopeKey: string): Promise<string | undefined> {
    const s = pgSchema.agentSessionsPostgres;
    const ps = pgSchema.providerSessionsPostgres;
    const rows = await this.db
      .select({ id: ps.externalSessionId })
      .from(ps)
      .innerJoin(s, eq(s.id, ps.agentSessionId))
      .where(
        and(
          eq(s.userId, scopeKey),
          eq(ps.provider, PROVIDER),
          eq(ps.status, 'active'),
        ),
      )
      .orderBy(sql`${ps.updatedAt} DESC`)
      .limit(1);
    return rows[0]?.id;
  }

  async getSessionResume(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
    scopeKey: string;
  }): Promise<{
    agentSessionId: string;
    providerSessionId?: string;
    externalSessionId?: string;
  }> {
    const agentSessionId = await this.ensureAgentSession(input);
    const ps = pgSchema.providerSessionsPostgres;
    const rows = await this.db
      .select({
        providerSessionId: ps.id,
        externalSessionId: ps.externalSessionId,
      })
      .from(ps)
      .where(
        and(
          eq(ps.agentSessionId, agentSessionId),
          eq(ps.provider, PROVIDER),
          eq(ps.status, 'active'),
        ),
      )
      .orderBy(sql`${ps.updatedAt} DESC`, sql`${ps.id} DESC`)
      .limit(1);
    return {
      agentSessionId,
      providerSessionId: rows[0]?.providerSessionId,
      externalSessionId: rows[0]?.externalSessionId,
    };
  }

  private async ensureAgentSession(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
    scopeKey: string;
  }): Promise<string> {
    const agentSessionId = `agent-session:${input.scopeKey}`;
    await this.db.transaction(async (tx) => {
      const agentId = await this.graph.ensureAgent(
        input.groupFolder,
        input.groupFolder,
        tx,
      );
      const conversationId = await this.graph.ensureConversation(
        input.chatJid,
        {},
        tx,
      );
      const canonicalThreadId = threadIdFor(input.chatJid, input.threadId);
      if (canonicalThreadId) {
        await this.graph.ensureThread(input.chatJid, input.threadId, tx);
      }
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId: CANONICAL_APP_ID,
          agentId,
          conversationId,
          threadId: canonicalThreadId,
          userId: input.scopeKey,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.agentSessionsPostgres.id,
          set: {
            conversationId,
            threadId: canonicalThreadId,
            status: 'active',
            updatedAt: sql`now()`,
          },
        });
    });
    return agentSessionId;
  }

  async setProviderSession(input: {
    groupFolder: string;
    scopeKey: string;
    sessionId: string;
    chatJid?: string;
    threadId?: string | null;
    artifactRef?: string | null;
  }): Promise<void> {
    const agentSessionId = `agent-session:${input.scopeKey}`;
    await this.db.transaction(async (tx) => {
      const agentId = await this.graph.ensureAgent(
        input.groupFolder,
        input.groupFolder,
        tx,
      );
      const conversationId = input.chatJid
        ? await this.graph.ensureConversation(input.chatJid, {}, tx)
        : null;
      const canonicalThreadId =
        input.chatJid && input.threadId
          ? await this.graph.ensureThread(input.chatJid, input.threadId, tx)
          : null;
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId: CANONICAL_APP_ID,
          agentId,
          conversationId,
          threadId: canonicalThreadId,
          userId: input.scopeKey,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.agentSessionsPostgres.id,
          set: { status: 'active', updatedAt: sql`now()` },
        });
      await tx
        .select({ id: pgSchema.agentSessionsPostgres.id })
        .from(pgSchema.agentSessionsPostgres)
        .where(eq(pgSchema.agentSessionsPostgres.id, agentSessionId))
        // Serialize provider-session replacement for this agent session.
        .for('update')
        .limit(1);
      await tx
        .delete(pgSchema.providerSessionsPostgres)
        .where(
          and(
            eq(
              pgSchema.providerSessionsPostgres.agentSessionId,
              agentSessionId,
            ),
            ne(pgSchema.providerSessionsPostgres.id, input.sessionId),
          ),
        );
      await tx
        .insert(pgSchema.providerSessionsPostgres)
        .values({
          id: input.sessionId,
          appId: CANONICAL_APP_ID,
          agentSessionId,
          provider: PROVIDER,
          externalSessionId: input.sessionId,
          artifactRef: input.artifactRef ?? null,
          providerRefJson: json({
            kind: 'provider_session',
            value: `${PROVIDER}:${input.sessionId}`,
            provider: PROVIDER,
            externalSessionId: input.sessionId,
            artifactRef: input.artifactRef ?? null,
          }),
          metadataJson: json({
            chatJid: input.chatJid ?? null,
            threadId: input.threadId ?? null,
          }),
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.providerSessionsPostgres.id,
          set: {
            agentSessionId,
            provider: PROVIDER,
            externalSessionId: input.sessionId,
            artifactRef: input.artifactRef ?? null,
            providerRefJson: json({
              kind: 'provider_session',
              value: `${PROVIDER}:${input.sessionId}`,
              provider: PROVIDER,
              externalSessionId: input.sessionId,
              artifactRef: input.artifactRef ?? null,
            }),
            metadataJson: json({
              chatJid: input.chatJid ?? null,
              threadId: input.threadId ?? null,
            }),
            updatedAt: sql`now()`,
          },
        });
      await tx
        .update(pgSchema.agentSessionsPostgres)
        .set({
          latestProviderSessionId: input.sessionId,
          updatedAt: sql`now()`,
        })
        .where(eq(pgSchema.agentSessionsPostgres.id, agentSessionId));
    });
  }

  async expireProviderSession(input: {
    providerSessionId?: string;
    agentSessionId?: string;
    provider?: string;
    externalSessionId?: string;
  }): Promise<void> {
    if (input.providerSessionId) {
      await this.db
        .update(pgSchema.providerSessionsPostgres)
        .set({ status: 'expired', updatedAt: sql`now()` })
        .where(
          eq(pgSchema.providerSessionsPostgres.id, input.providerSessionId),
        );
      return;
    }
    if (!input.agentSessionId || !input.externalSessionId) return;
    const predicates = [
      eq(
        pgSchema.providerSessionsPostgres.agentSessionId,
        input.agentSessionId,
      ),
      eq(
        pgSchema.providerSessionsPostgres.externalSessionId,
        input.externalSessionId,
      ),
    ];
    if (input.provider) {
      predicates.push(
        eq(pgSchema.providerSessionsPostgres.provider, input.provider),
      );
    }
    await this.db
      .update(pgSchema.providerSessionsPostgres)
      .set({ status: 'expired', updatedAt: sql`now()` })
      .where(and(...predicates));
  }

  async deleteScope(scopeKey: string): Promise<void> {
    await this.db
      .delete(pgSchema.agentSessionsPostgres)
      .where(eq(pgSchema.agentSessionsPostgres.userId, scopeKey));
  }

  async deleteGroupFolder(groupFolder: string): Promise<void> {
    await this.db
      .delete(pgSchema.agentSessionsPostgres)
      .where(
        or(
          eq(pgSchema.agentSessionsPostgres.userId, groupFolder),
          sql`${pgSchema.agentSessionsPostgres.userId} LIKE ${`${escapeLikePattern(groupFolder)}::thread:%`} ESCAPE '\\'`,
        ),
      );
  }

  async listSessions(): Promise<
    Array<{ scopeKey: string; sessionId: string }>
  > {
    const s = pgSchema.agentSessionsPostgres;
    const ps = pgSchema.providerSessionsPostgres;
    const rows = await this.db
      .select({ scopeKey: s.userId, sessionId: ps.id })
      .from(ps)
      .innerJoin(
        s,
        and(eq(s.id, ps.agentSessionId), sql`${s.userId} IS NOT NULL`),
      );
    return rows.flatMap((row) =>
      row.scopeKey
        ? [{ scopeKey: row.scopeKey, sessionId: row.sessionId }]
        : [],
    );
  }
}
