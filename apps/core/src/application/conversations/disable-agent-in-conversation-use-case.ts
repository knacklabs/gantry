import type { AgentChannelBinding } from '../../domain/channel/channel.js';
import { notImplemented } from '../common/application-error.js';

export class DisableAgentInConversationUseCase {
  async execute(input: { binding: AgentChannelBinding }) {
    void input;
    // TODO(next-phase): add binding status to the domain model or a repository delete contract.
    throw notImplemented('DisableAgentInConversationUseCase');
  }
}
