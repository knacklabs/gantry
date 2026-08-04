import { randomUUID } from 'node:crypto';
import type { MessageSendOptions } from '../domain/types.js';
import type { DeliverySettlement } from '../jobs/delivery.js';
import type { NewMessage } from '../domain/repositories/domain-types.js';
import { nowIso } from '../shared/time/datetime.js';

const NO_VISIBLE_OUTPUT_FALLBACK_MESSAGE =
  'I finished that run but did not generate a user-visible reply. Please send your message again.';

export async function finalizeGroupAgentUserVisibleOutput(input: {
  boundedTranscript: string | null;
  outputSentToUser: boolean;
  /** Completed generations that delivered nothing; see the fallback below. */
  undeliveredGenerations?: string;
  sawRawOutput: boolean;
  groupName: string;
  warn: (metadata: Record<string, unknown>, message: string) => void;
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
  // Text from generations that completed having delivered NOTHING. A run can
  // deliver its first generation and lose a later one (an interaction prompt
  // followed by a resumed answer); outputSentToUser is run-wide, so returning
  // early on it would drop that later generation silently.
  const undeliveredText = input.undeliveredGenerations?.trim() ?? '';

  if (outputSentToUser && !undeliveredText) {
    return { outputSentToUser, terminalSettlement };
  }

  const fallbackText = outputSentToUser ? undeliveredText : transcriptText;
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

/**
 * One durable assistant record per turn, whatever the flush path did.
 *
 * Per-generation persistence is the primary route; this covers a turn whose
 * visible output never reached a `done` flush, which would otherwise leave the
 * user holding a reply that GET /messages cannot show. Fires only when nothing
 * was persisted, so it cannot double-write, and only for STREAMING turns: a
 * non-streaming turn sends through sendMessageToChannel and channel-wiring
 * already writes the row via its message_row_projection.
 */
export async function persistTurnAssistantTranscript(input: {
  supportsStreamingChunks: boolean;
  persistedAnyGeneration: boolean;
  transcript: string | null;
  chatJid: string;
  activeThreadId?: string;
  outputSentToUser: boolean;
  groupName: string;
  storeMessage: (message: NewMessage) => Promise<unknown>;
  log: {
    info(input: unknown, message: string): void;
    warn(input: unknown, message: string): void;
  };
}): Promise<void> {
  const transcript = (input.transcript ?? '').trim();
  input.log.info(
    {
      group: input.groupName,
      supportsStreamingChunks: input.supportsStreamingChunks,
      persistedAnyGeneration: input.persistedAnyGeneration,
      transcriptChars: transcript.length,
    },
    'Turn assistant durability state',
  );
  if (!input.supportsStreamingChunks || input.persistedAnyGeneration) return;
  if (!transcript) return;
  const timestamp = nowIso();
  await input
    .storeMessage({
      id: `streamed-outbound:${randomUUID()}`,
      chat_jid: input.chatJid,
      sender: 'gantry',
      sender_name: 'Gantry',
      content: transcript,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
      thread_id: input.activeThreadId,
      delivery_status: input.outputSentToUser ? 'sent' : 'failed',
      delivered_at: input.outputSentToUser ? timestamp : undefined,
    })
    .catch((err: unknown) =>
      input.log.warn(
        { err, group: input.groupName },
        'Failed to persist turn assistant transcript',
      ),
    );
}
