import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../../domain/conversation/conversation.js';
import type { JobId } from '../../domain/jobs/jobs.js';
import type {
  AgentSession,
  ProviderSession,
} from '../../domain/sessions/sessions.js';
import type {
  AgentSessionRepository,
  ProviderSessionRepository,
} from '../../domain/ports/repositories.js';
import {
  deterministicAgentSessionId,
  resolveAgentSessionKey,
} from './session-identity.js';

export class CreateOrResumeSessionUseCase {
  constructor(
    private readonly sessions: AgentSessionRepository,
    private readonly providerSessions?: ProviderSessionRepository,
  ) {}

  async execute(
    input:
      | { session: AgentSession; provider?: string }
      | {
          appId: AppId;
          agentId: AgentId;
          conversationId: ConversationId;
          threadId?: ConversationThreadId;
          userId?: UserId;
          jobId?: JobId;
          modelOverride?: string;
          provider?: string;
          now?: string;
        },
  ) {
    if ('session' in input) {
      const existing = await this.sessions.getAgentSession(input.session.id);
      const session = existing ?? input.session;
      if (!existing) await this.sessions.saveAgentSession(input.session);
      const providerSession = await this.loadProviderSession(
        session,
        input.provider,
      );
      return { session, providerSession, created: !existing };
    }

    const sessionKey = resolveAgentSessionKey(input);
    const existing = await this.sessions.getAgentSessionByKey({
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      userId: input.userId,
    });
    if (existing) {
      return {
        session: existing,
        providerSession: await this.loadProviderSession(
          existing,
          input.provider,
        ),
        created: false,
        sessionKey,
      };
    }
    const now = input.now ?? new Date().toISOString();
    const session: AgentSession = {
      id: deterministicAgentSessionId(input),
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      jobId: input.jobId,
      userId: input.userId,
      status: 'active',
      modelOverride: input.modelOverride,
      createdAt: now,
      updatedAt: now,
    };
    await this.sessions.saveAgentSession(session);
    return {
      session,
      providerSession: await this.loadProviderSession(session, input.provider),
      created: true,
      sessionKey,
    };
  }

  private async loadProviderSession(
    session: AgentSession,
    provider?: string,
  ): Promise<ProviderSession | null> {
    if (!this.providerSessions) return null;
    if (session.status !== 'active') return null;
    return this.providerSessions.getLatestProviderSession({
      agentSessionId: session.id,
      provider,
    });
  }
}
