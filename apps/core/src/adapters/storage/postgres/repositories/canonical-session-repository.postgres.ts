import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalExecutor,
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
    const ensured = await this.ensureAgentSession(input);
    return {
      appId: CANONICAL_APP_ID,
      agentId: ensured.agentId,
      agentSessionId: ensured.agentSessionId,
    };
  }

  private async ensureAgentSession(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
    scopeKey: string;
  }): Promise<{ agentSessionId: string; agentId: string }> {
    const { groupFolder: folder, chatJid, threadId, scopeKey } = input;
    const agentSessionId = `agent-session:${scopeKey}`;
    const agentId = await this.db.transaction(async (tx) => {
      const conversationId = await this.graph.ensureConversation(
        chatJid,
        {},
        tx,
      );
      const canonicalThreadId = threadIdFor(chatJid, threadId);
      if (canonicalThreadId) {
        await this.graph.ensureThread(chatJid, threadId, tx);
      }
      const agentId = await this.resolveBoundAgentId(
        {
          folder,
          conversationId,
          threadId: canonicalThreadId,
        },
        tx,
      );
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId: CANONICAL_APP_ID,
          agentId,
          conversationId,
          threadId: canonicalThreadId,
          userId: scopeKey,
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
      return agentId;
    });
    return { agentSessionId, agentId };
  }

  private async resolveBoundAgentId(
    input: {
      folder: string;
      conversationId: string;
      threadId: string | null;
    },
    executor: CanonicalExecutor,
  ): Promise<string> {
    if (input.threadId) {
      const [threadBinding] = await executor
        .select({ agentId: pgSchema.agentChannelBindingsPostgres.agentId })
        .from(pgSchema.agentChannelBindingsPostgres)
        .where(
          and(
            eq(pgSchema.agentChannelBindingsPostgres.appId, CANONICAL_APP_ID),
            eq(
              pgSchema.agentChannelBindingsPostgres.conversationId,
              input.conversationId,
            ),
            eq(pgSchema.agentChannelBindingsPostgres.threadId, input.threadId),
            eq(pgSchema.agentChannelBindingsPostgres.status, 'active'),
          ),
        )
        .limit(1);
      if (threadBinding?.agentId) return threadBinding.agentId;
    }

    const [conversationBinding] = await executor
      .select({ agentId: pgSchema.agentChannelBindingsPostgres.agentId })
      .from(pgSchema.agentChannelBindingsPostgres)
      .where(
        and(
          eq(pgSchema.agentChannelBindingsPostgres.appId, CANONICAL_APP_ID),
          eq(
            pgSchema.agentChannelBindingsPostgres.conversationId,
            input.conversationId,
          ),
          isNull(pgSchema.agentChannelBindingsPostgres.threadId),
          eq(pgSchema.agentChannelBindingsPostgres.status, 'active'),
        ),
      )
      .limit(1);
    if (conversationBinding?.agentId) return conversationBinding.agentId;

    return this.graph.ensureAgent(input.folder, input.folder, executor);
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
    const {
      groupFolder: folder,
      scopeKey,
      sessionId,
      chatJid,
      threadId,
      latestArtifactId,
    } = input;
    const agentSessionId = `agent-session:${scopeKey}`;
    await this.db.transaction(async (tx) => {
      const conversationId = chatJid
        ? await this.graph.ensureConversation(chatJid, {}, tx)
        : null;
      const canonicalThreadId =
        chatJid && threadId
          ? await this.graph.ensureThread(chatJid, threadId, tx)
          : null;
      const agentId =
        conversationId !== null
          ? await this.resolveBoundAgentId(
              {
                folder,
                conversationId,
                threadId: canonicalThreadId,
              },
              tx,
            )
          : await this.graph.ensureAgent(folder, folder, tx);
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId: CANONICAL_APP_ID,
          agentId,
          conversationId,
          threadId: canonicalThreadId,
          userId: scopeKey,
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
        .where(eq(pgSchema.providerSessionsPostgres.id, sessionId))
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
          `Provider session id is already owned by another session: ${sessionId}`,
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
            ne(pgSchema.providerSessionsPostgres.id, sessionId),
          ),
        );
      await tx
        .insert(pgSchema.providerSessionsPostgres)
        .values({
          id: sessionId,
          appId: CANONICAL_APP_ID,
          agentSessionId,
          provider: PROVIDER,
          externalSessionId: sessionId,
          latestArtifactId: latestArtifactId ?? null,
          providerRefJson: json({
            kind: 'provider_session',
            value: `${PROVIDER}:${sessionId}`,
            provider: PROVIDER,
            externalSessionId: sessionId,
            latestArtifactId: latestArtifactId ?? null,
          }),
          metadataJson: json({
            chatJid: chatJid ?? null,
            threadId: threadId ?? null,
          }),
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.providerSessionsPostgres.id,
          set: {
            agentSessionId,
            provider: PROVIDER,
            externalSessionId: sessionId,
            latestArtifactId: latestArtifactId ?? null,
            providerRefJson: json({
              kind: 'provider_session',
              value: `${PROVIDER}:${sessionId}`,
              provider: PROVIDER,
              externalSessionId: sessionId,
              latestArtifactId: latestArtifactId ?? null,
            }),
            metadataJson: json({
              chatJid: chatJid ?? null,
              threadId: threadId ?? null,
            }),
            updatedAt: sql`now()`,
          },
        });
      await tx
        .update(pgSchema.agentSessionsPostgres)
        .set({
          latestProviderSessionId: sessionId,
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
