import type { AgentRun } from '../../domain/events/events.js';
import type { AgentRunRepository } from '../../domain/ports/repositories.js';

export class StartAgentRunUseCase {
  constructor(private readonly runs: AgentRunRepository) {}

  async execute(input: { run: AgentRun }) {
    await this.runs.saveAgentRun(input.run);
    return { run: input.run };
  }
}
