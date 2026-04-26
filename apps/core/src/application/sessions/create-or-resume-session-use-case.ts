import type { AgentSession } from '../../domain/sessions/sessions.js';
import type { AgentSessionRepository } from '../../domain/ports/repositories.js';

export class CreateOrResumeSessionUseCase {
  constructor(private readonly sessions: AgentSessionRepository) {}

  async execute(input: { session: AgentSession }) {
    const existing = await this.sessions.getAgentSession(input.session.id);
    if (existing) return { session: existing, created: false };
    await this.sessions.saveAgentSession(input.session);
    return { session: input.session, created: true };
  }
}
