import { and, eq, ne, or, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  agentIdForFolder,
  type CanonicalDb,
  json,
  PostgresCanonicalGraphRepository,
  threadIdFor,
} from './canonical-graph-repository.postgres.js';
import { assertSafeProviderSessionId } from '../../../../domain/sessions/provider-session-id.js';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const PROVIDER = 'anthropic';

export class PostgresCanonicalSessionRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async getAgentTurnContext(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
    scopeKey: string;
  }): Promise<{
    appId: string;
    agentId: string;
    agentSessionId: string;
  }> {
    const agentSessionId = await this.ensureAgentSession(input);
    return {
      appId: CANONICAL_APP_ID,
      agentId: agentIdForFolder(input.groupFolder),
      agentSessionId,
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
    latestArtifactId?: string | null;
  }): Promise<void> {
    assertSafeProviderSessionId(input.sessionId);
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
      const existingProviderSession = await tx
        .select({
          id: pgSchema.providerSessionsPostgres.id,
          appId: pgSchema.providerSessionsPostgres.appId,
          agentSessionId: pgSchema.providerSessionsPostgres.agentSessionId,
          provider: pgSchema.providerSessionsPostgres.provider,
        })
        .from(pgSchema.providerSessionsPostgres)
        .where(eq(pgSchema.providerSessionsPostgres.id, input.sessionId))
        .for('update')
        .limit(1);
      const existing = existingProviderSession[0];
      if (
        existing &&
        (existing.appId !== CANONICAL_APP_ID ||
          existing.agentSessionId !== agentSessionId ||
          existing.provider !== PROVIDER)
      ) {
        throw new Error(
          `Provider session id is already owned by another session: ${input.sessionId}`,
        );
      }
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
          latestArtifactId: input.latestArtifactId ?? null,
          providerRefJson: json({
            kind: 'provider_session',
            value: `${PROVIDER}:${input.sessionId}`,
            provider: PROVIDER,
            externalSessionId: input.sessionId,
            latestArtifactId: input.latestArtifactId ?? null,
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
            latestArtifactId: input.latestArtifactId ?? null,
            providerRefJson: json({
              kind: 'provider_session',
              value: `${PROVIDER}:${input.sessionId}`,
              provider: PROVIDER,
              externalSessionId: input.sessionId,
              latestArtifactId: input.latestArtifactId ?? null,
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
}
