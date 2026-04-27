import { makeSessionScopeKey } from '../../../../domain/repositories/ops-repo.js';
import type {
  AgentRunRepository,
  AgentSessionRepository,
  AgentSessionSummaryRepository,
  MemoryRepository,
  MessageRepository,
} from '../../../../domain/ports/repositories.js';
import { HydrateAgentContextService } from '../../../../application/sessions/hydrate-agent-context-service.js';
import { SessionSummaryCheckpointService } from '../../../../application/sessions/session-summary-checkpoint-service.js';
import type { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';

export class CanonicalSessionOpsService {
  private readonly hydrateService?: HydrateAgentContextService;
  private readonly checkpointService?: SessionSummaryCheckpointService;

  constructor(
    private readonly repository: PostgresCanonicalSessionRepository,
    repositories?: {
      agentSessions: AgentSessionRepository;
      messages: MessageRepository;
      memory: MemoryRepository;
      agentSessionSummaries: AgentSessionSummaryRepository;
      agentRuns: AgentRunRepository;
    },
    options: {
      recentMessageLimit?: number;
      summaryAfterMessages?: number;
      summaryAfterRuns?: number;
      maxHydratedContextChars?: number;
    } = {},
  ) {
    if (repositories) {
      this.hydrateService = new HydrateAgentContextService(
        repositories.agentSessions,
        repositories.messages,
        repositories.memory,
        repositories.agentSessionSummaries,
        repositories.agentRuns,
        {
          recentMessageLimit: options.recentMessageLimit,
          maxChars: options.maxHydratedContextChars,
        },
      );
      this.checkpointService = new SessionSummaryCheckpointService(
        repositories.agentSessions,
        repositories.messages,
        repositories.agentRuns,
        repositories.agentSessionSummaries,
        {
          summaryAfterMessages: options.summaryAfterMessages ?? 50,
          summaryAfterRuns: options.summaryAfterRuns ?? 10,
        },
      );
    }
  }

  async getSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<string | undefined> {
    return this.repository.getProviderSessionId(
      makeSessionScopeKey(groupFolder, threadId),
    );
  }

  async setSession(
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
    metadata: { chatJid?: string; artifactRef?: string | null } = {},
  ): Promise<void> {
    await this.repository.setProviderSession({
      groupFolder,
      sessionId,
      scopeKey: makeSessionScopeKey(groupFolder, threadId),
      chatJid: metadata.chatJid,
      threadId,
      artifactRef: metadata.artifactRef,
    });
  }

  async getSessionResume(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
  }): Promise<{
    agentSessionId: string;
    mode: 'provider_native' | 'db_replay';
    providerSessionId?: string;
    externalSessionId?: string;
    hydratedContextBlock?: string;
  }> {
    const resume = await this.repository.getSessionResume({
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      threadId: input.threadId,
      scopeKey: makeSessionScopeKey(input.groupFolder, input.threadId),
    });
    if (resume.externalSessionId) {
      return { ...resume, mode: 'provider_native' };
    }
    const hydrated = await this.hydrateService?.hydrate({
      sessionId: resume.agentSessionId as never,
    });
    return {
      ...resume,
      mode: 'db_replay',
      hydratedContextBlock: hydrated?.block,
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

  async checkpointSessionSummary(agentSessionId: string): Promise<void> {
    await this.checkpointService?.checkpoint({
      sessionId: agentSessionId as never,
    });
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

  async getAllSessions(): Promise<Record<string, string>> {
    const rows = await this.repository.listSessions();
    return Object.fromEntries(rows.map((row) => [row.scopeKey, row.sessionId]));
  }
}
