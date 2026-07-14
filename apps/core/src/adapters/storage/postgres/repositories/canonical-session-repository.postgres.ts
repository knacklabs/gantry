import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalExecutor,
  type CanonicalDb,
  agentIdForFolder,
  conversationIdForJid,
  json,
  jsonb,
  PostgresCanonicalGraphRepository,
  threadIdFor,
} from './canonical-graph-repository.postgres.js';
import {
  buildCurrentScopeResetMatcher,
  conversationKindInput,
  escapeLikePattern,
  expireProviderSession,
  findControlSessionForChatJid,
  finishProviderSessionMaintenance,
  isProviderSessionMaintenanceLocked,
  markLatestProviderSessionMaintenance,
  markProviderSessionDeltaReplay,
  makeOwnedAgentSessionId,
  makeOwnedAgentSessionScopeKey,
  promoteLatestReadyProviderSession,
  providerSessionContext,
  RESUMABLE_PROVIDER_SESSION_STATUSES,
  releaseStaleProviderSessionMaintenanceLocks,
  resolveSessionAppId,
  type ProviderSessionMaintenanceFinishInput,
  type ProviderSessionMaintenanceInput,
} from './canonical-session-repository-helpers.postgres.js';
import { assertSafeProviderSessionId } from '../../../../domain/sessions/provider-session-id.js';
import { assertSafeExecutionProviderId } from '../../../../domain/sessions/execution-provider-id.js';
import type { ExecutionProviderId } from '../../../../domain/sessions/sessions.js';
export { buildCurrentScopeResetMatcher, makeOwnedAgentSessionScopeKey };
export class PostgresCanonicalSessionRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async getAgentTurnContext(input: {
    appId?: string;
    workspaceFolder: string;
    executionProviderId: ExecutionProviderId;
    chatJid: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    scopeKey: string;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    jobId?: string;
    promoteReadyProviderSession?: boolean;
  }) {
    assertSafeExecutionProviderId(input.executionProviderId);
    const appId = resolveSessionAppId({
      appId: input.appId,
      chatJid: input.chatJid,
    });
    const ensured = await this.ensureAgentSession({ ...input, appId });
    const executionProviderId = input.executionProviderId;
    await releaseStaleProviderSessionMaintenanceLocks(this.db, {
      agentSessionId: ensured.agentSessionId,
      provider: executionProviderId,
    });
    if (input.promoteReadyProviderSession) {
      await promoteLatestReadyProviderSession(this.db, {
        agentSessionId: ensured.agentSessionId,
        provider: executionProviderId,
      });
    }
    const [providerSession] = await this.db
      .select({
        id: pgSchema.providerSessionsPostgres.id,
        externalSessionId: pgSchema.providerSessionsPostgres.externalSessionId,
        metadataJson: pgSchema.providerSessionsPostgres.metadataJson,
        status: pgSchema.providerSessionsPostgres.status,
      })
      .from(pgSchema.providerSessionsPostgres)
      .where(
        and(
          eq(
            pgSchema.providerSessionsPostgres.agentSessionId,
            ensured.agentSessionId,
          ),
          eq(pgSchema.providerSessionsPostgres.provider, executionProviderId),
          inArray(
            pgSchema.providerSessionsPostgres.status,
            RESUMABLE_PROVIDER_SESSION_STATUSES,
          ),
        ),
      )
      .orderBy(desc(pgSchema.providerSessionsPostgres.updatedAt))
      .limit(1);
    return {
      appId,
      agentId: ensured.agentId,
      agentSessionId: ensured.agentSessionId,
      agentSessionResetAt: ensured.agentSessionResetAt ?? null,
      ...(providerSession ? providerSessionContext(providerSession) : {}),
    };
  }

  private async ensureAgentSession(input: {
    appId: string;
    workspaceFolder: string;
    chatJid: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    scopeKey: string;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    jobId?: string;
  }): Promise<{
    agentSessionId: string;
    agentId: string;
    agentSessionResetAt?: string | null;
  }> {
    const {
      workspaceFolder: folder,
      appId,
      chatJid,
      providerAccountId,
      threadId,
      scopeKey,
      conversationKind,
      memoryUserId,
      jobId,
    } = input;
    const normalizedJobId = jobId?.trim() || null;
    const resolvedMemoryUserId = memoryUserId?.trim() || null;
    const sessionUserId =
      conversationKind === 'dm' && resolvedMemoryUserId
        ? resolvedMemoryUserId
        : scopeKey;
    const shouldUpdateMemoryUserId =
      conversationKind === 'dm' && Boolean(resolvedMemoryUserId);
    const ensured = await this.db.transaction(async (tx) => {
      const route = await this.resolveSessionRoute(
        {
          appId,
          folder,
          chatJid,
          providerAccountId,
          threadId,
          conversationKind,
        },
        tx,
      );
      const agentSessionId = makeOwnedAgentSessionId(
        route.agentId,
        scopeKey,
        appId,
      );
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId,
          agentId: route.agentId,
          conversationId: route.conversationId,
          threadId: route.canonicalThreadId,
          jobId: normalizedJobId,
          userId: sessionUserId,
          scopeKey,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.agentSessionsPostgres.id,
          set: {
            agentId: route.agentId,
            conversationId: route.conversationId,
            threadId: route.canonicalThreadId,
            jobId: normalizedJobId,
            ...(shouldUpdateMemoryUserId ? { userId: sessionUserId } : {}),
            scopeKey,
            status: 'active',
            updatedAt: sql`now()`,
          },
        });
      const [session] = await tx
        .select({ resetAt: pgSchema.agentSessionsPostgres.resetAt })
        .from(pgSchema.agentSessionsPostgres)
        .where(eq(pgSchema.agentSessionsPostgres.id, agentSessionId))
        .for('update')
        .limit(1);
      return {
        agentId: route.agentId,
        agentSessionId,
        agentSessionResetAt: session?.resetAt ?? null,
      };
    });
    return ensured;
  }
  private async resolveSessionRoute(
    input: {
      appId: string;
      folder: string;
      chatJid: string;
      providerAccountId?: string | null;
      threadId?: string | null;
      conversationKind?: 'dm' | 'channel';
    },
    executor: CanonicalExecutor,
  ): Promise<{
    appId: string;
    conversationId: string;
    canonicalThreadId: string | null;
    agentId: string;
  }> {
    if (input.appId === CANONICAL_APP_ID) {
      const conversationInput = {
        ...conversationKindInput(input.conversationKind),
        providerAccountId: input.providerAccountId,
      };
      const conversationId = await this.graph.ensureConversation(
        input.chatJid,
        conversationInput,
        executor,
      );
      const canonicalThreadId = threadIdFor(
        input.chatJid,
        input.threadId,
        input.providerAccountId,
      );
      if (canonicalThreadId) {
        await this.graph.ensureThread(input.chatJid, input.threadId, executor, {
          providerAccountId: input.providerAccountId,
        });
      }
      const agentId = await this.resolveBoundAgentId(
        {
          appId: input.appId,
          folder: input.folder,
          conversationId,
          threadId: canonicalThreadId,
        },
        executor,
      );
      return {
        appId: input.appId,
        conversationId,
        canonicalThreadId,
        agentId,
      };
    }
    const controlSession = await findControlSessionForChatJid(
      executor,
      input.appId,
      input.chatJid,
    );
    if (!controlSession) {
      throw new Error(
        `App session not found for conversation: ${input.chatJid}`,
      );
    }
    const canonicalThreadId = await this.ensureAppThread(
      {
        appId: input.appId,
        conversationId: controlSession.conversationId,
        chatJid: input.chatJid,
        threadId: input.threadId,
      },
      executor,
    );
    return {
      appId: input.appId,
      conversationId: controlSession.conversationId,
      canonicalThreadId,
      agentId: controlSession.agentId,
    };
  }
  private async ensureAppThread(
    input: {
      appId: string;
      conversationId: string;
      chatJid: string;
      threadId?: string | null;
    },
    executor: CanonicalExecutor,
  ): Promise<string | null> {
    const canonicalThreadId = threadIdFor(input.chatJid, input.threadId);
    if (!canonicalThreadId) return null;
    await executor
      .insert(pgSchema.conversationThreadsPostgres)
      .values({
        id: canonicalThreadId,
        appId: input.appId,
        conversationId: input.conversationId,
        externalRefJson: json({
          kind: 'conversation_thread',
          value: input.threadId,
          jid: input.chatJid,
          threadId: input.threadId,
          externalThreadId: input.threadId,
        }),
      })
      .onConflictDoNothing();
    return canonicalThreadId;
  }
  private async resolveBoundAgentId(
    input: {
      appId: string;
      folder: string;
      conversationId: string;
      threadId: string | null;
    },
    executor: CanonicalExecutor,
  ): Promise<string> {
    const selectedBindingAgentId = await this.findBoundAgentId(
      { ...input, agentId: agentIdForFolder(input.folder) },
      executor,
    );
    if (selectedBindingAgentId) return selectedBindingAgentId;
    return this.graph.ensureAgent(input.folder, input.folder, executor);
  }
  private async findBoundAgentId(
    input: {
      appId: string;
      conversationId: string;
      threadId: string | null;
      agentId?: string;
    },
    executor: CanonicalExecutor,
  ): Promise<string | undefined> {
    const b = pgSchema.conversationInstallsPostgres;
    if (input.threadId) {
      const [threadBinding] = await executor
        .select({ agentId: b.agentId })
        .from(b)
        .where(
          and(
            eq(b.appId, input.appId),
            eq(b.conversationId, input.conversationId),
            eq(b.threadId, input.threadId),
            input.agentId ? eq(b.agentId, input.agentId) : undefined,
            eq(b.status, 'active'),
          ),
        )
        .limit(1);
      if (threadBinding?.agentId) return threadBinding.agentId;
    }

    const [conversationBinding] = await executor
      .select({ agentId: b.agentId })
      .from(b)
      .where(
        and(
          eq(b.appId, input.appId),
          eq(b.conversationId, input.conversationId),
          isNull(b.threadId),
          input.agentId ? eq(b.agentId, input.agentId) : undefined,
          eq(b.status, 'active'),
        ),
      )
      .limit(1);
    return conversationBinding?.agentId;
  }
  async setProviderSession(input: {
    appId?: string;
    workspaceFolder: string;
    executionProviderId: ExecutionProviderId;
    scopeKey: string;
    sessionId: string;
    chatJid?: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    jobId?: string;
    expectedAgentSessionId?: string;
    expectedAgentSessionResetAt?: string | null;
    accessFingerprint?: string;
  }): Promise<boolean> {
    assertSafeProviderSessionId(input.sessionId);
    assertSafeExecutionProviderId(input.executionProviderId);
    const {
      workspaceFolder: folder,
      scopeKey,
      executionProviderId,
      sessionId,
      chatJid,
      providerAccountId,
      threadId,
      conversationKind,
      memoryUserId,
      jobId,
      expectedAgentSessionId,
      expectedAgentSessionResetAt,
      accessFingerprint,
    } = input;
    const appId = resolveSessionAppId({ appId: input.appId, chatJid });
    const normalizedJobId = jobId?.trim() || null;
    const resolvedMemoryUserId = memoryUserId?.trim() || null;
    const sessionUserId =
      conversationKind === 'dm' && resolvedMemoryUserId
        ? resolvedMemoryUserId
        : scopeKey;
    return this.db.transaction(async (tx) => {
      if (appId !== CANONICAL_APP_ID && !chatJid) {
        throw new Error(
          'App-scoped provider session persistence requires a conversation JID',
        );
      }
      const route = chatJid
        ? await this.resolveSessionRoute(
            {
              appId,
              folder,
              chatJid,
              providerAccountId,
              threadId,
              conversationKind,
            },
            tx,
          )
        : {
            appId,
            conversationId: null,
            canonicalThreadId: null,
            agentId: await this.graph.ensureAgent(folder, folder, tx),
          };
      const agentId = route.agentId;
      const agentSessionId = makeOwnedAgentSessionId(agentId, scopeKey, appId);
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId,
          agentId,
          conversationId: route.conversationId,
          threadId: route.canonicalThreadId,
          jobId: normalizedJobId,
          userId: sessionUserId,
          scopeKey,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.agentSessionsPostgres.id,
          set: {
            agentId,
            conversationId: route.conversationId,
            threadId: route.canonicalThreadId,
            jobId: normalizedJobId,
            userId: sessionUserId,
            scopeKey,
            status: 'active',
            updatedAt: sql`now()`,
          },
        });
      const [agentSession] = await tx
        .select({
          resetAt: pgSchema.agentSessionsPostgres.resetAt,
          latestProviderSessionId:
            pgSchema.agentSessionsPostgres.latestProviderSessionId,
        })
        .from(pgSchema.agentSessionsPostgres)
        .where(eq(pgSchema.agentSessionsPostgres.id, agentSessionId))
        .for('update')
        .limit(1);
      if (
        expectedAgentSessionId !== undefined &&
        expectedAgentSessionId !== agentSessionId
      ) {
        return false;
      }
      if (
        expectedAgentSessionResetAt !== undefined &&
        (agentSession?.resetAt ?? null) !== expectedAgentSessionResetAt
      ) {
        return false;
      }
      if (
        agentSession?.latestProviderSessionId &&
        (await isProviderSessionMaintenanceLocked(
          tx,
          agentSession.latestProviderSessionId,
        ))
      )
        return false;
      await tx
        .insert(pgSchema.providerSessionsPostgres)
        .values({
          id: sessionId,
          appId,
          agentSessionId,
          provider: executionProviderId,
          externalSessionId: sessionId,
          providerRefJson: jsonb({
            kind: 'provider_session',
            value: `${executionProviderId}:${sessionId}`,
            provider: executionProviderId,
            externalSessionId: sessionId,
          }),
          metadataJson: jsonb({
            chatJid: chatJid ?? null,
            providerAccountId: providerAccountId ?? null,
            conversationKind: conversationKind ?? null,
            memoryUserId: resolvedMemoryUserId,
            threadId: threadId ?? null,
            accessFingerprint: accessFingerprint ?? null,
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
        existing.appId !== appId ||
        existing.agentSessionId !== agentSessionId ||
        existing.provider !== executionProviderId ||
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
          providerRefJson: jsonb({
            kind: 'provider_session',
            value: `${executionProviderId}:${sessionId}`,
            provider: executionProviderId,
            externalSessionId: sessionId,
          }),
          metadataJson: jsonb({
            chatJid: chatJid ?? null,
            providerAccountId: providerAccountId ?? null,
            conversationKind: conversationKind ?? null,
            memoryUserId: resolvedMemoryUserId,
            threadId: threadId ?? null,
            accessFingerprint: accessFingerprint ?? null,
          }),
          status: 'active',
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(pgSchema.providerSessionsPostgres.id, sessionId),
            eq(pgSchema.providerSessionsPostgres.appId, appId),
            eq(pgSchema.providerSessionsPostgres.provider, executionProviderId),
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
            eq(pgSchema.providerSessionsPostgres.appId, appId),
            eq(
              pgSchema.providerSessionsPostgres.agentSessionId,
              agentSessionId,
            ),
            eq(pgSchema.providerSessionsPostgres.provider, executionProviderId),
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
      return true;
    });
  }
  async expireProviderSession(
    input: ProviderSessionMaintenanceInput,
  ): Promise<void> {
    await expireProviderSession(this.db, input);
  }
  async markProviderSessionMaintenance(
    input: ProviderSessionMaintenanceInput,
  ): Promise<boolean> {
    return markLatestProviderSessionMaintenance(this.db, input);
  }

  async markProviderSessionDeltaReplay(
    input: ProviderSessionMaintenanceInput & {
      status: 'applied' | 'degraded';
      reason?: string;
    },
  ): Promise<void> {
    await markProviderSessionDeltaReplay(this.db, input);
  }

  async finishProviderSessionMaintenance(
    input: ProviderSessionMaintenanceFinishInput,
  ): Promise<void> {
    await this.db.transaction((tx) =>
      finishProviderSessionMaintenance(tx, input),
    );
  }

  async resetScope(input: {
    appId?: string;
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
    const appId = resolveSessionAppId({
      appId: input.appId,
      chatJid: input.chatJid,
    });
    await this.db.transaction(async (tx) => {
      const explicitAgentId = input.agentId?.trim();
      let ownerAgentId: string | undefined = explicitAgentId || undefined;
      if (!ownerAgentId && input.chatJid) {
        if (appId === CANONICAL_APP_ID) {
          ownerAgentId = await this.findBoundAgentId(
            {
              appId,
              conversationId: conversationIdForJid(input.chatJid),
              threadId: threadIdFor(input.chatJid, input.threadId),
            },
            tx,
          );
        } else {
          ownerAgentId = (
            await findControlSessionForChatJid(tx, appId, input.chatJid)
          )?.agentId;
        }
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
  async deleteWorkspaceFolder(agentFolder: string): Promise<void> {
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
