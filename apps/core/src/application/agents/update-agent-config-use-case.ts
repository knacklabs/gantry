import type {
  AgentConfigVersionId,
  AgentId,
} from '../../domain/agent/agent.js';
import type { AgentRepository } from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import type { Clock } from '../common/clock.js';

export interface UpdateAgentConfigInput {
  agentId: AgentId;
  currentConfigVersionId?: AgentConfigVersionId;
  status?: 'active' | 'disabled';
}

export class UpdateAgentConfigUseCase {
  constructor(
    private readonly deps: {
      agents: AgentRepository;
      clock: Clock;
    },
  ) {}

  async execute(input: UpdateAgentConfigInput) {
    const agent = await this.deps.agents.getAgent(input.agentId);
    if (!agent) throw new ApplicationError('NOT_FOUND', 'Agent not found');
    const updated = {
      ...agent,
      currentConfigVersionId:
        input.currentConfigVersionId ?? agent.currentConfigVersionId,
      status: input.status ?? agent.status,
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.agents.saveAgent(updated);
    return { agent: updated };
  }
}
