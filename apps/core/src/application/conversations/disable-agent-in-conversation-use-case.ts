import type { AgentConversationBinding } from '../../domain/provider/provider.js';
import type { ProviderConnectionRepository } from '../../domain/ports/repositories.js';
import type { Clock } from '../common/clock.js';
import { ApplicationError } from '../common/application-error.js';

export class DisableAgentInConversationUseCase {
  constructor(
    private readonly deps: {
      providerConnections: ProviderConnectionRepository;
      clock: Clock;
    },
  ) {}

  async execute(input: { binding: AgentConversationBinding }) {
    const disabled =
      await this.deps.providerConnections.disableAgentConversationBinding({
        appId: input.binding.appId,
        agentId: input.binding.agentId,
        conversationId: input.binding.conversationId,
        threadId: input.binding.threadId,
        updatedAt: this.deps.clock.now(),
      });
    if (!disabled) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Agent conversation binding not found',
      );
    }
    return { binding: disabled };
  }
}
