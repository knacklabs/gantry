import { ChannelFactory, ChannelOpts } from '../channels/channel-provider.js';
import { createSlackChannel } from '../channels/slack.js';
import { createTelegramChannel } from '../channels/telegram.js';
import { RuntimeSettings } from '../cli/runtime-settings.js';

export type ChannelProviderId = 'slack' | 'telegram';

export interface ChannelProvider {
  id: ChannelProviderId;
  isEnabled: (runtimeSettings: RuntimeSettings) => boolean;
  create: ChannelFactory;
}

const BUILTIN_PROVIDER_LIST: ChannelProvider[] = [
  {
    id: 'slack',
    isEnabled: (runtimeSettings: RuntimeSettings) =>
      runtimeSettings.channels.slack.enabled,
    create: (opts: ChannelOpts) => createSlackChannel(opts),
  },
  {
    id: 'telegram',
    isEnabled: (runtimeSettings: RuntimeSettings) =>
      runtimeSettings.channels.telegram.enabled,
    create: (opts: ChannelOpts) => createTelegramChannel(opts),
  },
];

export const BUILTIN_CHANNEL_PROVIDERS: readonly ChannelProvider[] =
  Object.freeze(BUILTIN_PROVIDER_LIST);
