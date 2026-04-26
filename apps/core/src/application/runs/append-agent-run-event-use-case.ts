import type { AgentRunEvent } from '../../domain/events/events.js';
import type { AgentRunRepository } from '../../domain/ports/repositories.js';

export class AppendAgentRunEventUseCase {
  constructor(private readonly runs: AgentRunRepository) {}

  async execute(input: { event: AgentRunEvent }) {
    await this.runs.appendAgentRunEvent(input.event);
    return { event: input.event };
  }
}
