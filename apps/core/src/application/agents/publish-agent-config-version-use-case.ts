import type {
  AgentConfigVersion,
  AgentConfigVersionId,
} from '../../domain/agent/agent.js';
import type { AgentConfigRepository } from '../../domain/ports/repositories.js';
import type { IdGenerator } from '../common/id-generator.js';

export type PublishAgentConfigVersionInput = Omit<AgentConfigVersion, 'id'>;

export class PublishAgentConfigVersionUseCase {
  constructor(
    private readonly deps: {
      configs: AgentConfigRepository;
      ids: IdGenerator;
    },
  ) {}

  async execute(input: PublishAgentConfigVersionInput) {
    const version: AgentConfigVersion = {
      ...input,
      id: this.deps.ids.generate() as AgentConfigVersionId,
    };
    await this.deps.configs.saveConfigVersion(version);
    return { version };
  }
}
