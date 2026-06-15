import { HydrateAgentContextService } from '../../../../application/sessions/hydrate-agent-context-service.js';
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
import { CanonicalJobOpsService } from './canonical-job-ops-service.js';
import { PostgresCanonicalJobRepository } from '../repositories/canonical-job-repository.postgres.js';
import type { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';
import type { CanonicalDb } from '../repositories/canonical-graph-repository.postgres.js';

type SessionAppMemoryLoaderInput = {
  session: AgentSession;
  limit: number;
  conversationKind?: string;
  query?: string;
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
            ? async ({ session, limit, conversationKind, query }) => {
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
      executionProviderId: ExecutionProviderId;
      chatJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      jobId?: string;
      expectedAgentSessionId?: string;
      expectedAgentSessionResetAt?: string | null;
      accessFingerprint?: string;
    },
  ): Promise<boolean> {
    return this.repository.setProviderSession({
      workspaceFolder,
      executionProviderId: metadata.executionProviderId,
      sessionId,
      scopeKey: makeSessionScopeKey(workspaceFolder, threadId, {
        conversationJid: metadata.chatJid,
        conversationKind: metadata.conversationKind,
        userId: metadata.memoryUserId,
        jobId: metadata.jobId,
      }),
      chatJid: metadata.chatJid,
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
    workspaceFolder: string;
    executionProviderId: ExecutionProviderId;
    chatJid: string;
    threadId?: string | null;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    jobId?: string;
    query?: string;
    hydrateMemory?: boolean;
  }): Promise<{
    appId: string;
    agentId: string;
    agentSessionId: string;
    providerSessionId?: string;
    externalSessionId?: string;
    providerSessionAccessFingerprint?: string;
    agentSessionResetAt?: string | null;
    memoryContextBlock?: string;
  }> {
    const context = await this.repository.getAgentTurnContext({
      workspaceFolder: input.workspaceFolder,
      executionProviderId: input.executionProviderId,
      chatJid: input.chatJid,
      threadId: input.threadId,
      scopeKey: makeSessionScopeKey(input.workspaceFolder, input.threadId, {
        conversationJid: input.chatJid,
        conversationKind: input.conversationKind,
        userId: input.memoryUserId,
        jobId: input.jobId,
      }),
      conversationKind: input.conversationKind,
      memoryUserId: input.memoryUserId,
      jobId: input.jobId,
    });
    const hydrated =
      input.hydrateMemory === false
        ? undefined
        : await this.hydrateService?.hydrate({
            sessionId: context.agentSessionId as never,
            conversationKind: input.conversationKind,
            query: input.query,
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

  async deleteSession(
    workspaceFolder: string,
    threadId?: string | null,
    metadata: {
      chatJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      agentId?: string;
    } = {},
  ): Promise<void> {
    await this.repository.resetScope({
      scopeKey: makeSessionScopeKey(workspaceFolder, threadId, {
        conversationJid: metadata.chatJid,
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
    const conversationJid = conversationJidFromCanonicalId(
      input.session.conversationId,
    );
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
  return conversationId.startsWith('conversation:')
    ? conversationId.slice('conversation:'.length)
    : conversationId;
}

function threadIdFromCanonicalId(
  threadId: string | undefined,
  conversationJid: string,
): string | null {
  if (!threadId) return null;
  const prefix = `thread:${conversationJid}:`;
  return threadId.startsWith(prefix) ? threadId.slice(prefix.length) : threadId;
}
