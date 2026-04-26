import type { AgentChannelBinding } from '../../domain/channel/channel.js';
import type { ChannelInstallationRepository } from '../../domain/ports/repositories.js';

export class EnableAgentInConversationUseCase {
  constructor(
    private readonly deps: {
      installations: ChannelInstallationRepository;
    },
  ) {}

  async execute(input: { binding: AgentChannelBinding }) {
    await this.deps.installations.saveAgentChannelBinding(input.binding);
    return { binding: input.binding };
  }
}
