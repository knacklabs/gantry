import type { AgentSessionId } from '../../domain/sessions/sessions.js';
import type {
  AgentSessionRepository,
  ProviderSessionRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';

export class ResumeSessionUseCase {
  constructor(
    private readonly sessions: AgentSessionRepository,
    private readonly providerSessions: ProviderSessionRepository,
  ) {}

  async execute(input: { sessionId: AgentSessionId; provider: string }) {
    const session = await this.sessions.getAgentSession(input.sessionId);
    if (!session) throw new ApplicationError('NOT_FOUND', 'Session not found');
    const providerSession =
      session.status === 'active'
        ? await this.providerSessions.getLatestProviderSession({
            agentSessionId: session.id,
            provider: input.provider,
          })
        : null;
    return { session, providerSession };
  }
}
