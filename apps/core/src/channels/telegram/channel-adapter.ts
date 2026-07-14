import { logger } from '../../infrastructure/logging/logger.js';
import { ChannelOpts } from '../channel-provider.js';
import { getProviderRuntimeSecret } from '../provider-runtime-secrets.js';
import { TelegramChannelDelivery } from './channel-delivery.js';

export type TelegramChannelOpts = ChannelOpts;

export class TelegramChannel extends TelegramChannelDelivery {
  name = 'telegram';
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
