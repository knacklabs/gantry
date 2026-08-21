import { logger } from '../../infrastructure/logging/logger.js';
import { ChannelOpts } from '../channel-provider.js';
import { getProviderRuntimeSecret } from '../provider-runtime-secrets.js';
import { SlackChannelDelivery } from './channel-delivery.js';
import { SLACK_LIVE_UX_CAPABILITY } from './live-ux.js';
import type {
  ContentCanvasAction,
  ContentCanvasResult,
} from '../../shared/content-canvas.js';
import type { MessageSendOptions } from '../../domain/types.js';
import {
  prepareSlackPermissionCardSend,
  slackPermissionApproverIds,
} from './permission-approval-delivery.js';

export class SlackChannel extends SlackChannelDelivery {
  name = 'slack';
  readonly liveUx = SLACK_LIVE_UX_CAPABILITY;

  preparePermissionCardSend(
    jid: string,
    _text: string,
    options: MessageSendOptions & {
      permissionCardView: NonNullable<MessageSendOptions['permissionCardView']>;
    },
  ) {
    if (!this.interactionCallbacksEnabled || !this.app) {
      throw new Error('Slack approval surface is unavailable.');
    }
    const parsed = this.parseJid(jid);
    if (!parsed) throw new Error('Slack conversation is invalid.');
    return prepareSlackPermissionCardSend({
      app: this.app,
      channelId: parsed.channelId,
      approverUserIds: slackPermissionApproverIds(
        this.opts.runtimeSettings,
        this.opts.providerAccountId,
        parsed.channelId,
      ),
      options,
    });
  }

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
