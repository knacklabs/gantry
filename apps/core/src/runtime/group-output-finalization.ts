import { randomUUID } from 'node:crypto';

import type { MessageSendOptions, NewMessage } from '../domain/types.js';

const NO_VISIBLE_OUTPUT_FALLBACK_MESSAGE =
  'I finished that run but did not generate a user-visible reply. Please send your message again.';

export async function finalizeGroupAgentUserVisibleOutput(input: {
  streamedOutputDelivered: boolean;
  collectedOutput: string;
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
  ) => Promise<void>;
}): Promise<boolean> {
  let outputSentToUser = input.outputSentToUser;

  if (input.streamedOutputDelivered) {
    const transcriptText = input.collectedOutput.trim();
    if (transcriptText) {
      const transcriptMessage: NewMessage = {
        id: `streamed-outbound:${randomUUID()}`,
        chat_jid: input.chatJid,
        sender: 'myclaw',
        sender_name: 'MyClaw',
        content: transcriptText,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
        thread_id: input.activeThreadId,
        delivery_status: 'sent',
        delivered_at: new Date().toISOString(),
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

  if (outputSentToUser) return outputSentToUser;

  const fallbackText = input.collectedOutput.trim();
  if (fallbackText) {
    try {
      const messageOptions = await input.buildMessageOptions();
      await input.sendMessageToChannel(fallbackText, messageOptions);
      outputSentToUser = true;
      input.warn(
        { group: input.groupName, fallbackChars: fallbackText.length },
        'Streamed output was not confirmed as delivered; sent fallback message',
      );
    } catch (err) {
      input.warn(
        { err, group: input.groupName },
        'Failed to send fallback message after streaming run',
      );
    }
  } else if (input.sawRawOutput) {
    try {
      const messageOptions = await input.buildMessageOptions();
      await input.sendMessageToChannel(
        NO_VISIBLE_OUTPUT_FALLBACK_MESSAGE,
        messageOptions,
      );
      outputSentToUser = true;
      input.warn(
        { group: input.groupName },
        'Agent produced only non-displayable output; sent explicit fallback notice',
      );
    } catch (err) {
      input.warn(
        { err, group: input.groupName },
        'Failed to send no-visible-output fallback notice after streaming run',
      );
    }
  }

  return outputSentToUser;
}
