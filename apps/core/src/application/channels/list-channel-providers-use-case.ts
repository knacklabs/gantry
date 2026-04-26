import type { ChannelProvider } from '../../domain/channel/channel.js';
import type { ChannelProviderCatalogPort } from './channel-provider-ports.js';

export class ListChannelProvidersUseCase {
  constructor(private readonly providers: ChannelProviderCatalogPort) {}

  async execute(): Promise<{ providers: ChannelProvider[] }> {
    return { providers: await this.providers.listProviders() };
  }
}
