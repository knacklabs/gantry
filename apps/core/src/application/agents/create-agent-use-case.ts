import type { Agent, AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentRepository } from '../../domain/ports/repositories.js';
import type { Clock } from '../common/clock.js';
import type { IdGenerator } from '../common/id-generator.js';

export interface CreateAgentInput {
  appId: AppId;
  name: string;
}

export interface CreateAgentOutput {
  agent: Agent;
}

export class CreateAgentUseCase {
  constructor(
    private readonly deps: {
      agents: AgentRepository;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async execute(input: CreateAgentInput): Promise<CreateAgentOutput> {
    const now = this.deps.clock.now();
    const agent: Agent = {
      id: this.deps.ids.generate() as AgentId,
      appId: input.appId,
      name: input.name.trim(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.agents.saveAgent(agent);
    return { agent };
  }
}
