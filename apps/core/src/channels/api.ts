export type {
  ChannelAdapter,
  ChannelFactory,
  ChannelOpts,
} from './channel-provider.js';
export {
  getChannelProvider,
  listChannelProviders,
  providerForJid,
  registerChannelProvider,
} from './provider-registry.js';
export type { ChannelProvider } from './provider-registry.js';
