import { logger } from '../../infrastructure/logging/logger.js';
import { ChannelOpts } from '../channel-provider.js';
import { getProviderRuntimeSecret } from '../provider-runtime-secrets.js';
import { TelegramChannelDelivery } from './channel-delivery.js';
import { TELEGRAM_LIVE_UX_CAPABILITY } from './live-ux.js';

export type TelegramChannelOpts = ChannelOpts;

export class TelegramChannel extends TelegramChannelDelivery {
  name = 'telegram';
  readonly liveUx = TELEGRAM_LIVE_UX_CAPABILITY;
}

export async function createTelegramChannel(
  opts: ChannelOpts,
): Promise<TelegramChannel | null> {
  const token = await getProviderRuntimeSecret({
    providerId: 'telegram',
    providerAccountId: opts.providerAccountId ?? '',
    key: 'bot_token',
    settings: opts.runtimeSettings?.(),
    secrets: opts.runtimeSecrets,
  });
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
}
