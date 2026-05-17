import { randomUUID } from 'node:crypto';

import type { MessageSendOptions, NewMessage } from '../domain/types.js';
import type { DeliverySettlement } from '../jobs/delivery.js';
import { nowIso } from '../shared/time/datetime.js';

const NO_VISIBLE_OUTPUT_FALLBACK_MESSAGE =
  'I finished that run but did not generate a user-visible reply. Please send your message again.';

export async function finalizeGroupAgentUserVisibleOutput(input: {
  streamedTranscriptDeliveryStatus: 'none' | 'sent' | 'partially_sent';
  boundedTranscript: string | null;
  chatJid: string;
  activeThreadId?: string;
  outputSentToUser: boolean;
  sawRawOutput: boolean;
  groupName: string;
  warn: (metadata: Record<string, unknown>, message: string) => void;
  storeMessage: (message: NewMessage) => Promise<unknown>;
  buildMessageOptions: () =>
    | MessageSendOptions
    | undefined
    | Promise<MessageSendOptions | undefined>;
  sendMessageToChannel: (
    text: string,
    options?: MessageSendOptions,
  ) => Promise<DeliverySettlement>;
}): Promise<{
  outputSentToUser: boolean;
  terminalSettlement: DeliverySettlement;
}> {
  let outputSentToUser = input.outputSentToUser;
  let terminalSettlement: DeliverySettlement = 'sent';
  const transcriptText = input.boundedTranscript?.trim() ?? '';

  if (input.streamedTranscriptDeliveryStatus !== 'none') {
    if (transcriptText) {
      const deliveryStatus =
        input.streamedTranscriptDeliveryStatus === 'sent'
          ? 'sent'
          : 'partially_sent';
      const transcriptMessage: NewMessage = {
        id: `streamed-outbound:${randomUUID()}`,
        chat_jid: input.chatJid,
        sender: 'myclaw',
        sender_name: 'Gantry',
        content: transcriptText,
        timestamp: nowIso(),
        is_from_me: true,
        is_bot_message: true,
        thread_id: input.activeThreadId,
        delivery_status: deliveryStatus,
        delivered_at: nowIso(),
      };
      await input
        .storeMessage(transcriptMessage)
        .catch((err: unknown) =>
          input.warn(
            { err, group: input.groupName },
            'Failed to persist streamed assistant transcript',
          ),
        );
    }
  }

  if (outputSentToUser) {
    return { outputSentToUser, terminalSettlement };
  }

  const fallbackText = transcriptText;
  if (fallbackText) {
    try {
      const messageOptions = await input.buildMessageOptions();
      terminalSettlement = await input.sendMessageToChannel(
        fallbackText,
        messageOptions,
      );
      outputSentToUser = terminalSettlement !== 'not_delivered';
      if (outputSentToUser) {
        input.warn(
          { group: input.groupName, fallbackChars: fallbackText.length },
          'Streamed output was not confirmed as delivered; sent fallback message',
        );
      }
    } catch (err) {
      input.warn(
        { err, group: input.groupName },
        'Failed to send fallback message after streaming run',
      );
    }
  } else if (input.sawRawOutput) {
    try {
      const messageOptions = await input.buildMessageOptions();
      terminalSettlement = await input.sendMessageToChannel(
        NO_VISIBLE_OUTPUT_FALLBACK_MESSAGE,
        messageOptions,
      );
      outputSentToUser = terminalSettlement !== 'not_delivered';
      if (outputSentToUser) {
        input.warn(
          { group: input.groupName },
          'Agent produced only non-displayable output; sent explicit fallback notice',
        );
      }
    } catch (err) {
      input.warn(
        { err, group: input.groupName },
        'Failed to send no-visible-output fallback notice after streaming run',
      );
    }
  }

  return { outputSentToUser, terminalSettlement };
}
