import type { AgentSessionId } from '../../domain/sessions/sessions.js';
import type { AgentSessionRepository } from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';

export class ResumeSessionUseCase {
  constructor(private readonly sessions: AgentSessionRepository) {}

  async execute(input: { sessionId: AgentSessionId }) {
    const session = await this.sessions.getAgentSession(input.sessionId);
    if (!session) throw new ApplicationError('NOT_FOUND', 'Session not found');
    return { session };
  }
}
