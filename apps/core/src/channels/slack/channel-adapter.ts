import { logger } from '../../infrastructure/logging/logger.js';
import { ChannelOpts } from '../channel-provider.js';
import { getProviderRuntimeSecret } from '../provider-runtime-secrets.js';
import { SlackChannelDelivery } from './channel-delivery.js';
import type {
  ContentCanvasAction,
  ContentCanvasResult,
} from '../../shared/content-canvas.js';

export class SlackChannel extends SlackChannelDelivery {
  name = 'slack';

  executeCanvasAction(
    conversationJid: string,
    action: ContentCanvasAction,
  ): Promise<ContentCanvasResult> {
    return this.canvasService.executeCanvasAction(conversationJid, action);
  }
}

export async function createSlackChannel(
  opts: ChannelOpts,
): Promise<SlackChannel | null> {
  const settings = opts.runtimeSettings?.();
  const botToken = await getProviderRuntimeSecret({
    providerId: 'slack',
    providerAccountId: opts.providerAccountId ?? '',
    key: 'bot_token',
    settings,
    secrets: opts.runtimeSecrets,
  });
  const appToken = await getProviderRuntimeSecret({
    providerId: 'slack',
    providerAccountId: opts.providerAccountId ?? '',
    key: 'app_token',
    settings,
    secrets: opts.runtimeSecrets,
  });
  if (!botToken || !appToken) {
    logger.warn('Slack: SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
    return null;
  }

  return new SlackChannel(botToken, appToken, opts);
}
