import { makeSessionScopeKey } from '../../../../domain/repositories/ops-repo.js';
import type {
  AgentSessionRepository,
  MemoryRepository,
} from '../../../../domain/ports/repositories.js';
import { HydrateAgentContextService } from '../../../../application/sessions/hydrate-agent-context-service.js';
import type { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';

export class CanonicalSessionOpsService {
  private readonly hydrateService?: HydrateAgentContextService;

  constructor(
    private readonly repository: PostgresCanonicalSessionRepository,
    repositories?: {
      agentSessions: AgentSessionRepository;
      memory: MemoryRepository;
    },
    options: {
      memoryItemLimit?: number;
      maxMemoryContextChars?: number;
    } = {},
  ) {
    if (repositories) {
      this.hydrateService = new HydrateAgentContextService(
        repositories.agentSessions,
        repositories.memory,
        {
          memoryItemLimit: options.memoryItemLimit,
          maxChars: options.maxMemoryContextChars,
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
      latestArtifactId?: string | null;
    } = {},
  ): Promise<void> {
    await this.repository.setProviderSession({
      groupFolder,
      sessionId,
      scopeKey: makeSessionScopeKey(groupFolder, threadId),
      chatJid: metadata.chatJid,
      threadId,
      latestArtifactId: metadata.latestArtifactId,
    });
  }

  async getAgentTurnContext(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
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
      scopeKey: makeSessionScopeKey(input.groupFolder, input.threadId),
    });
    const hydrated = await this.hydrateService?.hydrate({
      sessionId: context.agentSessionId as never,
    });
    return {
      ...context,
      memoryContextBlock: hydrated?.block || undefined,
    };
  }

  async expireProviderSession(input: {
    providerSessionId?: string;
    agentSessionId?: string;
    provider?: string;
    externalSessionId?: string;
  }): Promise<void> {
    await this.repository.expireProviderSession(input);
  }

  async deleteSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<void> {
    await this.repository.deleteScope(
      makeSessionScopeKey(groupFolder, threadId),
    );
  }

  async deleteSessionsByGroupFolder(groupFolder: string): Promise<void> {
    await this.repository.deleteGroupFolder(groupFolder);
  }
}
