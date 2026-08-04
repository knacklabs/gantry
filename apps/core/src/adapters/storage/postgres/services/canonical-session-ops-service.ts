import {
  HydrateAgentContextService,
  type HydrationMode,
} from '../../../../application/sessions/hydrate-agent-context-service.js';
import type {
  AgentSessionDigestRepository,
  AgentSessionRepository,
  ConversationRepository,
} from '../../../../domain/ports/repositories.js';
import { makeSessionScopeKey } from '../../../../domain/repositories/ops-repo.js';
import type {
  AgentSession,
  ExecutionProviderId,
} from '../../../../domain/sessions/sessions.js';
import { providerIdForJid } from '../../../../channels/provider-registry.js';
import { CanonicalJobOpsService } from './canonical-job-ops-service.js';
import { PostgresCanonicalJobRepository } from '../repositories/canonical-job-repository.postgres.js';
import type { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';
import type { CanonicalDb } from '../repositories/canonical-graph-repository.postgres.js';

type SessionAppMemoryLoaderInput = {
  session: AgentSession;
  limit: number;
  conversationKind?: string;
  query?: string;
  hydrationMode: HydrationMode;
  statementTimeoutMs?: number;
};
type HydratedAppMemoryItem = {
  id: string;
  kind: string;
  key: string;
  value: string;
  subject: Record<string, unknown>;
};
type HydratedContinuityJob = {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'running' | 'dead_lettered';
  nextRunAt?: string;
  lastRunAt?: string;
  target?: unknown;
};

export class CanonicalSessionOpsService {
  private readonly hydrateService?: HydrateAgentContextService;
  private readonly continuityJobOps?: CanonicalJobOpsService;
  private readonly conversations?: ConversationRepository;

  constructor(
    private readonly repository: PostgresCanonicalSessionRepository,
    repositories?: {
      agentSessions: AgentSessionRepository;
      agentSessionDigests?: AgentSessionDigestRepository;
      conversations?: ConversationRepository;
      loadAppMemoryItems?: (
        input: SessionAppMemoryLoaderInput,
      ) => Promise<HydratedAppMemoryItem[]>;
      loadContinuityJobs?: (input: {
        session: AgentSession;
        limit: number;
      }) => Promise<HydratedContinuityJob[]>;
    },
    options: {
      memoryItemLimit?: number;
      maxMemoryContextChars?: number;
    } = {},
  ) {
    this.continuityJobOps = createContinuityJobOps(repository);
    this.conversations = repositories?.conversations;
    if (repositories) {
      this.hydrateService = new HydrateAgentContextService(
        repositories.agentSessions,
        {
          memoryItemLimit: options.memoryItemLimit,
          maxChars: options.maxMemoryContextChars,
        },
        {
          digests: repositories.agentSessionDigests,
          loadAppMemoryItems: repositories.loadAppMemoryItems
            ? async ({
                session,
                limit,
                conversationKind,
                query,
                hydrationMode,
                statementTimeoutMs,
              }) => {
                const resolvedConversationKind = conversationKind
                  ? conversationKind
                  : session.conversationId
                    ? await repositories.conversations?.getConversation(
                        session.conversationId,
                      )
                    : null;
                return repositories.loadAppMemoryItems!({
                  session,
                  limit,
                  query,
                  hydrationMode,
                  ...(statementTimeoutMs ? { statementTimeoutMs } : {}),
                  conversationKind:
                    typeof resolvedConversationKind === 'string'
                      ? resolvedConversationKind
                      : resolvedConversationKind?.kind,
                });
              }
            : undefined,
          loadContinuityJobs:
            repositories.loadContinuityJobs ??
            (this.continuityJobOps
              ? (input) => this.loadProductionContinuityJobs(input)
              : undefined),
        },
      );
    }
  }

  async setSession(
    workspaceFolder: string,
    sessionId: string,
    threadId: string | null | undefined,
    metadata: {
      appId?: string;
      executionProviderId: ExecutionProviderId;
      chatJid?: string;
      providerAccountId?: string | null;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      jobId?: string;
      expectedAgentSessionId?: string;
      expectedAgentSessionResetAt?: string | null;
      accessFingerprint?: string;
    },
  ): Promise<boolean> {
    return this.repository.setProviderSession({
      appId: metadata.appId,
      workspaceFolder,
      executionProviderId: metadata.executionProviderId,
      sessionId,
      scopeKey: makeSessionScopeKey(workspaceFolder, threadId, {
        conversationJid: metadata.chatJid,
        providerAccountId: metadata.providerAccountId,
        conversationKind: metadata.conversationKind,
        userId: metadata.memoryUserId,
        jobId: metadata.jobId,
      }),
      chatJid: metadata.chatJid,
      providerAccountId: metadata.providerAccountId,
      threadId,
      conversationKind: metadata.conversationKind,
      memoryUserId: metadata.memoryUserId,
      jobId: metadata.jobId,
      expectedAgentSessionId: metadata.expectedAgentSessionId,
      expectedAgentSessionResetAt: metadata.expectedAgentSessionResetAt,
      accessFingerprint: metadata.accessFingerprint,
    });
  }

  async getAgentTurnContext(input: {
    appId?: string;
    workspaceFolder: string;
    executionProviderId: ExecutionProviderId;
    chatJid: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    jobId?: string;
    query?: string;
    hydrateMemory?: boolean;
    hydrationMode?: HydrationMode;
    promoteReadyProviderSession?: boolean;
  }): Promise<{
    appId: string;
    agentId: string;
    agentSessionId: string;
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
    agentSessionResetAt?: string | null;
    memoryContextBlock?: string;
  }> {
    const context = await this.repository.getAgentTurnContext({
      appId: input.appId,
      workspaceFolder: input.workspaceFolder,
      executionProviderId: input.executionProviderId,
      chatJid: input.chatJid,
      providerAccountId: input.providerAccountId,
      threadId: input.threadId,
      scopeKey: makeSessionScopeKey(input.workspaceFolder, input.threadId, {
        conversationJid: input.chatJid,
        providerAccountId: input.providerAccountId,
        conversationKind: input.conversationKind,
        userId: input.memoryUserId,
        jobId: input.jobId,
      }),
      conversationKind: input.conversationKind,
      memoryUserId: input.memoryUserId,
      jobId: input.jobId,
      promoteReadyProviderSession: input.promoteReadyProviderSession,
    });
    const hydrated =
      input.hydrateMemory === false
        ? undefined
        : await this.hydrateService?.hydrate({
            sessionId: context.agentSessionId as never,
            conversationKind: input.conversationKind,
            query: input.query,
            hydrationMode: input.hydrationMode,
          });
    return {
      ...context,
      memoryContextBlock: hydrated?.block || undefined,
    };
  }

  async expireProviderSession(input: {
    providerSessionId: string;
    agentSessionId: string;
    provider: string;
    externalSessionId: string;
  }): Promise<void> {
    await this.repository.expireProviderSession(input);
  }

  async markProviderSessionMaintenance(input: {
    providerSessionId: string;
    agentSessionId: string;
    provider: string;
    externalSessionId: string;
    compactionBaseCursor?: string | null;
  }): Promise<boolean> {
    return this.repository.markProviderSessionMaintenance(input);
  }

  async markProviderSessionDeltaReplay(input: {
    providerSessionId: string;
    agentSessionId: string;
    provider: string;
    externalSessionId: string;
    status: 'applied' | 'degraded';
    reason?: string;
  }): Promise<void> {
    await this.repository.markProviderSessionDeltaReplay(input);
  }

  async finishProviderSessionMaintenance(input: {
    providerSessionId: string;
    agentSessionId: string;
    provider: string;
    externalSessionId: string;
    status: 'active' | 'expired' | 'ready';
  }): Promise<void> {
    await this.repository.finishProviderSessionMaintenance(input);
  }

  async deleteSession(
    workspaceFolder: string,
    threadId?: string | null,
    metadata: {
      appId?: string;
      chatJid?: string;
      providerAccountId?: string | null;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      agentId?: string;
    } = {},
  ): Promise<void> {
    await this.repository.resetScope({
      appId: metadata.appId,
      scopeKey: makeSessionScopeKey(workspaceFolder, threadId, {
        conversationJid: metadata.chatJid,
        providerAccountId: metadata.providerAccountId,
        conversationKind: metadata.conversationKind,
        userId: metadata.memoryUserId,
      }),
      chatJid: metadata.chatJid,
      threadId,
      agentId: metadata.agentId,
    });
  }

  async deleteSessionsByWorkspaceFolder(
    workspaceFolder: string,
  ): Promise<void> {
    await this.repository.deleteWorkspaceFolder(workspaceFolder);
  }

  private async loadProductionContinuityJobs(input: {
    session: AgentSession;
    limit: number;
  }): Promise<HydratedContinuityJob[]> {
    if (!this.continuityJobOps) return [];
    const conversationJid = await this.conversationJidForSession(input.session);
    if (!conversationJid) return [];
    const threadId = threadIdFromCanonicalId(
      input.session.threadId,
      conversationJid,
    );
    const jobs = await this.continuityJobOps.listJobs({
      appId: input.session.appId,
      statuses: ['active', 'paused'],
      agentId: input.session.agentId,
      conversationJid,
      threadId,
      limit: Math.max(input.limit, 1),
    });
    return jobs
      .filter((job) => {
        const execution = job.execution_context;
        return (
          (job.status === 'active' || job.status === 'paused') &&
          execution?.conversationJid === conversationJid &&
          (execution.threadId ?? null) === (threadId ?? null)
        );
      })
      .slice(0, input.limit)
      .map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status as 'active' | 'paused',
        ...(job.next_run ? { nextRunAt: job.next_run } : {}),
        ...(job.last_run ? { lastRunAt: job.last_run } : {}),
        target: {
          executionContext: job.execution_context,
          notificationRoutes: job.notification_routes,
        },
      }));
  }

  private async conversationJidForSession(
    session: AgentSession,
  ): Promise<string | undefined> {
    const conversation =
      session.conversationId &&
      (await this.conversations?.getConversation(session.conversationId));
    return (
      conversation?.externalRef?.value ??
      conversationJidFromCanonicalId(session.conversationId)
    );
  }
}

function createContinuityJobOps(
  repository: PostgresCanonicalSessionRepository,
): CanonicalJobOpsService | undefined {
  const db = (repository as unknown as { db?: CanonicalDb }).db;
  return db
    ? new CanonicalJobOpsService(new PostgresCanonicalJobRepository(db))
    : undefined;
}

function conversationJidFromCanonicalId(
  conversationId: string | undefined,
): string | undefined {
  if (!conversationId) return undefined;
  if (!conversationId.startsWith('conversation:')) return conversationId;
  const value = conversationId.slice('conversation:'.length);
  return stripProviderAccountPrefix(value);
}

function threadIdFromCanonicalId(
  threadId: string | undefined,
  conversationJid: string,
): string | null {
  if (!threadId) return null;
  const prefix = `thread:${conversationJid}:`;
  if (threadId.startsWith(prefix)) return threadId.slice(prefix.length);
  const scopedPrefix = `:${conversationJid}:`;
  if (threadId.startsWith('thread:')) {
    const idx = threadId.indexOf(scopedPrefix, 'thread:'.length);
    if (idx >= 0) return threadId.slice(idx + scopedPrefix.length);
  }
  return threadId;
}

function stripProviderAccountPrefix(value: string): string {
  if (providerIdForJid(value, '')) return value;
  for (
    let idx = value.indexOf(':');
    idx >= 0;
    idx = value.indexOf(':', idx + 1)
  ) {
    const candidate = value.slice(idx + 1);
    if (providerIdForJid(candidate, '')) return candidate;
  }
  return value;
}
