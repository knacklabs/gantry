import type { MessageSendOptions } from '../domain/types.js';
import type {
  PreparedPermissionCardSend,
  PreparedPermissionCardSink,
} from '../domain/permission-card.js';
import {
  buildBoundedPermissionCard,
  permissionCardCallback,
} from './permission-card.js';
import { buttonRows, permissionCustomId } from './discord-components.js';
import { discordChannelIdFromJid } from './discord-interaction-helpers.js';
import { discordPermissionFullViewCustomId } from './discord-permission-full-view.js';
import {
  permissionButtonLabel,
  permissionDecisionOptions,
} from './permission-interaction.js';

export function prepareDiscordPermissionCardSend(input: {
  jid: string;
  options: MessageSendOptions & {
    permissionCardView: NonNullable<MessageSendOptions['permissionCardView']>;
  };
  postMessage: (
    channelId: string,
    body: Record<string, unknown>,
  ) => Promise<{ id?: string }>;
}): PreparedPermissionCardSend {
  const channelId =
    input.options.threadId || discordChannelIdFromJid(input.jid);
  if (!channelId)
    throw new Error(`Invalid Discord conversation id: ${input.jid}`);
  const view = input.options.permissionCardView;
  const callback = permissionCardCallback(view);
  const card = buildBoundedPermissionCard(view);
  const buttons = [
    ...(card.fullViewAvailable
      ? [
          {
            label: card.parts.fullView?.label ?? 'View details',
            style: 2,
            custom_id: discordPermissionFullViewCustomId(
              callback.providerAlias,
            ),
          },
        ]
      : []),
    ...permissionDecisionOptions(view.request).map((mode) => ({
      label: permissionButtonLabel(mode, view.request),
      style: mode === 'cancel' ? 4 : 1,
      custom_id: permissionCustomId(callback.providerAlias, mode),
    })),
  ];
  return {
    send: async () => {
      const sent = await input.postMessage(channelId, {
        content: card.text,
        components: buttonRows(buttons),
      });
      if (!sent.id)
        throw new Error('Discord did not return a permission card id.');
      return {
        delivery: { externalMessageId: sent.id },
        locator: {
          provider: 'discord',
          conversationId: discordChannelIdFromJid(input.jid) || input.jid,
          messageId: sent.id,
          ...(input.options.threadId
            ? { threadId: input.options.threadId }
            : {}),
        },
      };
    },
  };
}

export function createDiscordPermissionCardPreparer(
  postMessage: (
    channelId: string,
    body: Record<string, unknown>,
  ) => Promise<{ id?: string }>,
): PreparedPermissionCardSink['preparePermissionCardSend'] {
  return (jid, _text, options) =>
    prepareDiscordPermissionCardSend({ jid, options, postMessage });
}
