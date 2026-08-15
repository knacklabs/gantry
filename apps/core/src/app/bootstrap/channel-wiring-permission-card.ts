import type { PreparedPermissionCardSink } from '../../domain/permission-card.js';
import type { MessageSendOptions } from '../../domain/types.js';
import { assertRecoveryDispatchPermit } from './channel-wiring-delivery-guards.js';
import type { RecoveryDispatchPermit } from './channel-wiring-types.js';

export function prepareProviderPermissionCardSend(input: {
  jid: string;
  rawText: string;
  permit: RecoveryDispatchPermit;
  messageOptions: MessageSendOptions & {
    permissionCardView: NonNullable<MessageSendOptions['permissionCardView']>;
  };
  findChannel: (
    jid: string,
    providerAccountId: string | undefined,
    route: { threadId?: string; agentId?: string },
  ) => ({ name: string } & Partial<PreparedPermissionCardSink>) | undefined;
}) {
  assertRecoveryDispatchPermit(input.permit, {
    jid: input.jid,
    rawText: input.rawText,
    threadId: input.messageOptions.threadId,
  });
  const channel = input.findChannel(
    input.jid,
    input.messageOptions.providerAccountId,
    {
      threadId: input.messageOptions.threadId,
      agentId: input.messageOptions.agentId,
    },
  );
  if (!channel) throw new Error(`No channel for JID: ${input.jid}`);
  if (typeof channel.preparePermissionCardSend !== 'function') {
    throw new Error(
      `Channel ${channel.name} does not support prepared permission cards.`,
    );
  }
  return channel.preparePermissionCardSend(
    input.jid,
    input.rawText,
    input.messageOptions,
  );
}
