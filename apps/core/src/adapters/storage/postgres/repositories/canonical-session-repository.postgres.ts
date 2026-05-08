import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalExecutor,
  type CanonicalDb,
  conversationIdForJid,
  json,
  PostgresCanonicalGraphRepository,
  threadIdFor,
} from './canonical-graph-repository.postgres.js';
import { assertSafeProviderSessionId } from '../../../../domain/sessions/provider-session-id.js';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const PROVIDER = 'anthropic';

export function makeOwnedAgentSessionScopeKey(
  agentId: string,
  routeScopeKey: string,
): string {
  return `agent:${encodeURIComponent(agentId)}::${routeScopeKey}`;
}

function makeOwnedAgentSessionId(
  agentId: string,
  routeScopeKey: string,
): string {
  return `agent-session:${makeOwnedAgentSessionScopeKey(agentId, routeScopeKey)}`;
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

function conversationKindInput(kind?: 'dm' | 'channel'): {
  isGroup?: boolean;
} {
  if (kind === 'channel') return { isGroup: true };
  if (kind === 'dm') return { isGroup: false };
  return {};
}

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
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
  }): Promise<{
    appId: string;
    agentId: string;
    agentSessionId: string;
    providerSessionId?: string;
    externalSessionId?: string;
    latestArtifactId?: string | null;
  }> {
    const ensured = await this.ensureAgentSession(input);
    const [providerSession] = await this.db
      .select({
        id: pgSchema.providerSessionsPostgres.id,
        externalSessionId: pgSchema.providerSessionsPostgres.externalSessionId,
        latestArtifactId: pgSchema.providerSessionsPostgres.latestArtifactId,
      })
      .from(pgSchema.providerSessionsPostgres)
      .where(
        and(
          eq(
            pgSchema.providerSessionsPostgres.agentSessionId,
            ensured.agentSessionId,
          ),
          eq(pgSchema.providerSessionsPostgres.provider, PROVIDER),
          eq(pgSchema.providerSessionsPostgres.status, 'active'),
        ),
      )
      .orderBy(desc(pgSchema.providerSessionsPostgres.updatedAt))
      .limit(1);
    return {
      appId: CANONICAL_APP_ID,
      agentId: ensured.agentId,
      agentSessionId: ensured.agentSessionId,
      ...(providerSession
        ? {
            providerSessionId: providerSession.id,
            externalSessionId: providerSession.externalSessionId,
            latestArtifactId: providerSession.latestArtifactId,
          }
        : {}),
    };
  }

  private async ensureAgentSession(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
    scopeKey: string;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
  }): Promise<{ agentSessionId: string; agentId: string }> {
    const {
      groupFolder: folder,
      chatJid,
      threadId,
      scopeKey,
      conversationKind,
      memoryUserId,
    } = input;
    const resolvedMemoryUserId = memoryUserId?.trim() || null;
    const sessionUserId =
      conversationKind === 'dm' && resolvedMemoryUserId
        ? resolvedMemoryUserId
        : scopeKey;
    const shouldUpdateMemoryUserId =
      conversationKind === 'dm' && Boolean(resolvedMemoryUserId);
    const ensured = await this.db.transaction(async (tx) => {
      const conversationInput = conversationKindInput(conversationKind);
      const conversationId = await this.graph.ensureConversation(
        chatJid,
        conversationInput,
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
      const agentSessionId = makeOwnedAgentSessionId(agentId, scopeKey);
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId: CANONICAL_APP_ID,
          agentId,
          conversationId,
          threadId: canonicalThreadId,
          userId: sessionUserId,
          scopeKey,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.agentSessionsPostgres.id,
          set: {
            agentId,
            conversationId,
            threadId: canonicalThreadId,
            ...(shouldUpdateMemoryUserId ? { userId: sessionUserId } : {}),
            scopeKey,
            status: 'active',
            updatedAt: sql`now()`,
          },
        });
      return { agentId, agentSessionId };
    });
    return ensured;
  }

  private async resolveBoundAgentId(
    input: {
      folder: string;
      conversationId: string;
      threadId: string | null;
    },
    executor: CanonicalExecutor,
  ): Promise<string> {
    const boundAgentId = await this.findBoundAgentId(input, executor);
    if (boundAgentId) return boundAgentId;

    return this.graph.ensureAgent(input.folder, input.folder, executor);
  }

  private async findBoundAgentId(
    input: {
      conversationId: string;
      threadId: string | null;
    },
    executor: CanonicalExecutor,
  ): Promise<string | undefined> {
    if (input.threadId) {
      const [threadBinding] = await executor
        .select({ agentId: pgSchema.agentConversationBindingsPostgres.agentId })
        .from(pgSchema.agentConversationBindingsPostgres)
        .where(
          and(
            eq(
              pgSchema.agentConversationBindingsPostgres.appId,
              CANONICAL_APP_ID,
            ),
            eq(
              pgSchema.agentConversationBindingsPostgres.conversationId,
              input.conversationId,
            ),
            eq(
              pgSchema.agentConversationBindingsPostgres.threadId,
              input.threadId,
            ),
            eq(pgSchema.agentConversationBindingsPostgres.status, 'active'),
          ),
        )
        .limit(1);
      if (threadBinding?.agentId) return threadBinding.agentId;
    }

    const [conversationBinding] = await executor
      .select({ agentId: pgSchema.agentConversationBindingsPostgres.agentId })
      .from(pgSchema.agentConversationBindingsPostgres)
      .where(
        and(
          eq(
            pgSchema.agentConversationBindingsPostgres.appId,
            CANONICAL_APP_ID,
          ),
          eq(
            pgSchema.agentConversationBindingsPostgres.conversationId,
            input.conversationId,
          ),
          isNull(pgSchema.agentConversationBindingsPostgres.threadId),
          eq(pgSchema.agentConversationBindingsPostgres.status, 'active'),
        ),
      )
      .limit(1);
    return conversationBinding?.agentId;
  }

  async setProviderSession(input: {
    groupFolder: string;
    scopeKey: string;
    sessionId: string;
    chatJid?: string;
    threadId?: string | null;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    latestArtifactId?: string | null;
  }): Promise<void> {
    assertSafeProviderSessionId(input.sessionId);
    const {
      groupFolder: folder,
      scopeKey,
      sessionId,
      chatJid,
      threadId,
      conversationKind,
      memoryUserId,
      latestArtifactId,
    } = input;
    const resolvedMemoryUserId = memoryUserId?.trim() || null;
    const sessionUserId =
      conversationKind === 'dm' && resolvedMemoryUserId
        ? resolvedMemoryUserId
        : scopeKey;
    await this.db.transaction(async (tx) => {
      const conversationId = chatJid
        ? await this.graph.ensureConversation(
            chatJid,
            conversationKindInput(conversationKind),
            tx,
          )
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
      const agentSessionId = makeOwnedAgentSessionId(agentId, scopeKey);
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId: CANONICAL_APP_ID,
          agentId,
          conversationId,
          threadId: canonicalThreadId,
          userId: sessionUserId,
          scopeKey,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.agentSessionsPostgres.id,
          set: {
            agentId,
            conversationId,
            threadId: canonicalThreadId,
            userId: sessionUserId,
            scopeKey,
            status: 'active',
            updatedAt: sql`now()`,
          },
        });
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
            conversationKind: conversationKind ?? null,
            memoryUserId: resolvedMemoryUserId,
            threadId: threadId ?? null,
          }),
          status: 'active',
        })
        .onConflictDoNothing();
      const [existing] = await tx
        .select({
          appId: pgSchema.providerSessionsPostgres.appId,
          agentSessionId: pgSchema.providerSessionsPostgres.agentSessionId,
          provider: pgSchema.providerSessionsPostgres.provider,
          externalSessionId:
            pgSchema.providerSessionsPostgres.externalSessionId,
        })
        .from(pgSchema.providerSessionsPostgres)
        .where(eq(pgSchema.providerSessionsPostgres.id, sessionId))
        .for('update')
        .limit(1);
      if (
        !existing ||
        existing.appId !== CANONICAL_APP_ID ||
        existing.agentSessionId !== agentSessionId ||
        existing.provider !== PROVIDER ||
        existing.externalSessionId !== sessionId
      ) {
        throw new Error(
          `Provider session id is already owned by another session: ${sessionId}`,
        );
      }
      await tx
        .update(pgSchema.providerSessionsPostgres)
        .set({
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
            conversationKind: conversationKind ?? null,
            memoryUserId: resolvedMemoryUserId,
            threadId: threadId ?? null,
          }),
          status: 'active',
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(pgSchema.providerSessionsPostgres.id, sessionId),
            eq(pgSchema.providerSessionsPostgres.appId, CANONICAL_APP_ID),
            eq(pgSchema.providerSessionsPostgres.provider, PROVIDER),
            eq(
              pgSchema.providerSessionsPostgres.agentSessionId,
              agentSessionId,
            ),
            eq(pgSchema.providerSessionsPostgres.externalSessionId, sessionId),
          ),
        );
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
        .update(pgSchema.agentSessionsPostgres)
        .set({
          latestProviderSessionId: sessionId,
          updatedAt: sql`now()`,
        })
        .where(eq(pgSchema.agentSessionsPostgres.id, agentSessionId));
    });
  }

  async expireProviderSession(input: {
    providerSessionId: string;
    agentSessionId: string;
    provider: string;
    externalSessionId: string;
  }): Promise<void> {
    const providerSessionId = input.providerSessionId.trim();
    const agentSessionId = input.agentSessionId.trim();
    const provider = input.provider.trim();
    const externalSessionId = input.externalSessionId.trim();
    if (
      !providerSessionId ||
      !agentSessionId ||
      !provider ||
      !externalSessionId
    ) {
      return;
    }
    await this.db
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

  async resetScope(input: {
    scopeKey: string;
    chatJid?: string;
    threadId?: string | null;
    agentId?: string;
  }): Promise<void> {
    const matcher = buildCurrentScopeResetMatcher(input.scopeKey);
    const predicates = [
      eq(pgSchema.agentSessionsPostgres.scopeKey, matcher.currentScopeExact),
    ];
    if (matcher.currentScopeDescendantLike) {
      predicates.push(
        sql`${pgSchema.agentSessionsPostgres.scopeKey} LIKE ${matcher.currentScopeDescendantLike} ESCAPE '\\'`,
      );
    }
    await this.db.transaction(async (tx) => {
      const explicitAgentId = input.agentId?.trim();
      let ownerAgentId: string | undefined = explicitAgentId || undefined;
      if (!ownerAgentId && input.chatJid) {
        ownerAgentId = await this.findBoundAgentId(
          {
            conversationId: conversationIdForJid(input.chatJid),
            threadId: threadIdFor(input.chatJid, input.threadId),
          },
          tx,
        );
      }
      const rows = await tx
        .select({ id: pgSchema.agentSessionsPostgres.id })
        .from(pgSchema.agentSessionsPostgres)
        .where(
          and(
            eq(pgSchema.agentSessionsPostgres.appId, CANONICAL_APP_ID),
            or(...predicates),
            ...(ownerAgentId
              ? [eq(pgSchema.agentSessionsPostgres.agentId, ownerAgentId)]
              : []),
          ),
        )
        .for('update');
      const sessionIds = rows.map((row) => row.id);
      if (sessionIds.length === 0) return;

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
    });
  }

  async deleteGroupFolder(agentFolder: string): Promise<void> {
    const escapedAgentFolder = escapeLikePattern(agentFolder);
    await this.db
      .delete(pgSchema.agentSessionsPostgres)
      .where(
        and(
          eq(pgSchema.agentSessionsPostgres.appId, CANONICAL_APP_ID),
          or(
            eq(pgSchema.agentSessionsPostgres.scopeKey, agentFolder),
            sql`${pgSchema.agentSessionsPostgres.scopeKey} LIKE ${`${escapedAgentFolder}::%`} ESCAPE '\\'`,
          ),
        ),
      );
  }
}
