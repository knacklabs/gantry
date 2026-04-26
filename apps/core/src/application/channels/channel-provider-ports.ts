import type { ChannelProvider } from '../../domain/channel/channel.js';

export interface ChannelProviderCatalogPort {
  listProviders(): Promise<ChannelProvider[]> | ChannelProvider[];
}
