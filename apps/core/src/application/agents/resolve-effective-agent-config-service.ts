import type { AgentConfigVersion, AgentId } from '../../domain/agent/agent.js';
import type {
  AgentConfigRepository,
  AgentRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';

export class ResolveEffectiveAgentConfigService {
  constructor(
    private readonly deps: {
      agents: AgentRepository;
      configs: AgentConfigRepository;
    },
  ) {}

  async resolve(input: {
    agentId: AgentId;
  }): Promise<{ config: AgentConfigVersion }> {
    const agent = await this.deps.agents.getAgent(input.agentId);
    if (!agent) throw new ApplicationError('NOT_FOUND', 'Agent not found');
    if (!agent.currentConfigVersionId) {
      throw new ApplicationError(
        'CONFLICT',
        'Agent has no published config version',
      );
    }
    const config = await this.deps.configs.getConfigVersion(
      agent.currentConfigVersionId,
    );
    if (!config) {
      throw new ApplicationError('NOT_FOUND', 'Agent config version not found');
    }
    return { config };
  }
}
