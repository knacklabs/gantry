import { HydrateAgentContextService } from '../../../../application/sessions/hydrate-agent-context-service.js';
import type {
  AgentSessionDigestRepository,
  AgentSessionRepository,
  ConversationRepository,
} from '../../../../domain/ports/repositories.js';
import { makeSessionScopeKey } from '../../../../domain/repositories/ops-repo.js';
import type { AgentSession } from '../../../../domain/sessions/sessions.js';
import type { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';

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

export class CanonicalSessionOpsService {
  private readonly hydrateService?: HydrateAgentContextService;

  constructor(
    private readonly repository: PostgresCanonicalSessionRepository,
    repositories?: {
      agentSessions: AgentSessionRepository;
      agentSessionDigests?: AgentSessionDigestRepository;
      conversations?: ConversationRepository;
      loadAppMemoryItems?: (
        input: SessionAppMemoryLoaderInput,
      ) => Promise<HydratedAppMemoryItem[]>;
    },
    options: {
      memoryItemLimit?: number;
      maxMemoryContextChars?: number;
    } = {},
  ) {
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
        },
      );
    }
  }

  async setSession(
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
    metadata: {
      chatJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      latestArtifactId?: string | null;
    } = {},
  ): Promise<void> {
    await this.repository.setProviderSession({
      groupFolder,
      sessionId,
      scopeKey: makeSessionScopeKey(groupFolder, threadId, {
        conversationJid: metadata.chatJid,
        conversationKind: metadata.conversationKind,
        userId: metadata.memoryUserId,
      }),
      chatJid: metadata.chatJid,
      threadId,
      conversationKind: metadata.conversationKind,
      memoryUserId: metadata.memoryUserId,
      latestArtifactId: metadata.latestArtifactId,
    });
  }

  async getAgentTurnContext(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    query?: string;
    hydrateMemory?: boolean;
  }): Promise<{
    appId: string;
    agentId: string;
    agentSessionId: string;
    providerSessionId?: string;
    externalSessionId?: string;
    latestArtifactId?: string | null;
    memoryContextBlock?: string;
  }> {
    const context = await this.repository.getAgentTurnContext({
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      threadId: input.threadId,
      scopeKey: makeSessionScopeKey(input.groupFolder, input.threadId, {
        conversationJid: input.chatJid,
        conversationKind: input.conversationKind,
        userId: input.memoryUserId,
      }),
      conversationKind: input.conversationKind,
      memoryUserId: input.memoryUserId,
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
    groupFolder: string,
    threadId?: string | null,
    metadata: {
      chatJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      agentId?: string;
    } = {},
  ): Promise<void> {
    await this.repository.resetScope({
      scopeKey: makeSessionScopeKey(groupFolder, threadId, {
        conversationJid: metadata.chatJid,
        conversationKind: metadata.conversationKind,
        userId: metadata.memoryUserId,
      }),
      chatJid: metadata.chatJid,
      threadId,
      agentId: metadata.agentId,
    });
  }

  async deleteSessionsByGroupFolder(groupFolder: string): Promise<void> {
    await this.repository.deleteGroupFolder(groupFolder);
  }
}
