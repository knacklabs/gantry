import type { ChannelInstallationId } from '../../domain/channel/channel.js';
import type { Conversation } from '../../domain/conversation/conversation.js';

export interface ConversationDiscoveryPort {
  discover(input: {
    channelInstallationId: ChannelInstallationId;
  }): Promise<Conversation[]>;
}

export class DiscoverConversationsUseCase {
  constructor(private readonly discovery: ConversationDiscoveryPort) {}

  async execute(input: { channelInstallationId: ChannelInstallationId }) {
    return { conversations: await this.discovery.discover(input) };
  }
}
