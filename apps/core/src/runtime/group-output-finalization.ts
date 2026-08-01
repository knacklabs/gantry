import type { MessageSendOptions } from '../domain/types.js';
import type { DeliverySettlement } from '../jobs/delivery.js';

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
