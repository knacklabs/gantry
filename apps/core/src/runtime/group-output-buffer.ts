import type {
  MessageSendOptions,
  StreamingChunkOptions,
} from '../domain/types.js';
import {
  settleDeliveryAttempt,
  type DeliverySettlement,
} from '../jobs/delivery.js';
import { formatOutboundForChannel } from '../messaging/router.js';
import {
  createRuntimeResultSummaryAccumulator,
  createRuntimeUserVisibleResultAccumulator,
  createRuntimeUserVisibleStreamSanitizer,
} from './session-resume-runtime.js';
import type { GroupProcessingDeps } from './group-processing-types.js';

type RuntimeLogger = {
  info(input: unknown, message: string): void;
  warn(input: unknown, message: string): void;
};

export function createGroupOutputBuffer(input: {
  channelRuntime: GroupProcessingDeps['channelRuntime'];
  chatJid: string;
  groupName: string;
  supportsStreamingChunks: boolean;
  buildStreamingOptions: (args: { done?: boolean }) => StreamingChunkOptions;
  buildMessageOptions: () =>
    | MessageSendOptions
    | undefined
    | Promise<MessageSendOptions | undefined>;
  sendMessageToChannel: (
    text: string,
    options?: MessageSendOptions,
  ) => Promise<void>;
  applyDeliverySettlement: (
    settlement: DeliverySettlement,
    options: { streamed: boolean; terminal: boolean },
  ) => void;
  log: RuntimeLogger;
}) {
  const userVisibleTranscript = createRuntimeResultSummaryAccumulator();
  const fullUserVisibleTranscriptParts: string[] = [];
  let pendingOutputSummary = createRuntimeUserVisibleResultAccumulator();
  let pendingFullVisibleParts: string[] = [];
  let streamSanitizer = createRuntimeUserVisibleStreamSanitizer();
  let pendingOutputRawChars = 0;
  let pendingOutputHasParts = false;

  const flushBufferedOutput = async (
    reason: string,
    options: { done?: boolean; terminal?: boolean } = {},
  ) => {
    if (!pendingOutputHasParts) return false;
    const done = options.done ?? true;
    const terminal = options.terminal ?? true;
    const visibleSummary = pendingOutputSummary.snapshot();
    const finalStreamDelta = streamSanitizer.finish();
    if (finalStreamDelta) pendingFullVisibleParts.push(finalStreamDelta);
    const fullVisibleOutput = pendingFullVisibleParts.join('');
    const rawChars = pendingOutputRawChars;
    pendingOutputSummary = createRuntimeUserVisibleResultAccumulator();
    pendingFullVisibleParts = [];
    streamSanitizer = createRuntimeUserVisibleStreamSanitizer();
    pendingOutputRawChars = 0;
    pendingOutputHasParts = false;
    const text = fullVisibleOutput ? formatOutboundForChannel(fullVisibleOutput) : '';
    input.log.info(
      { group: input.groupName },
      `Agent output: ${rawChars} chars`,
    );
    if (!text) return false;
    if (input.supportsStreamingChunks) {
      const settlement = await settleDeliveryAttempt(
        () =>
          input.channelRuntime.sendStreamingChunk(
            input.chatJid,
            finalStreamDelta,
            input.buildStreamingOptions({ done }),
          ),
        { scope: 'runtime-streaming-output-final', target: input.chatJid },
      ).catch((err) => {
        input.log.warn(
          { err, group: input.groupName, reason },
          'Failed to send finalized streaming output',
        );
        return 'not_delivered' as const;
      });
      input.applyDeliverySettlement(settlement, { streamed: true, terminal });
    } else {
      const messageOptions = await input.buildMessageOptions();
      const settlement = await settleDeliveryAttempt(
        () => input.sendMessageToChannel(text, messageOptions),
        { scope: 'runtime-output-message-final', target: input.chatJid },
      );
      input.applyDeliverySettlement(settlement, { streamed: false, terminal });
    }
    if (visibleSummary) userVisibleTranscript.append(`${text}\n`);
    if (text) fullUserVisibleTranscriptParts.push(text);
    return true;
  };

  return {
    appendRawOutput: async (raw: string) => {
      pendingOutputHasParts = true;
      pendingOutputRawChars += raw.length;
      pendingOutputSummary.append(raw);
      const safeDelta = streamSanitizer.append(raw);
      if (safeDelta) pendingFullVisibleParts.push(safeDelta);
      if (!input.supportsStreamingChunks || !safeDelta) return;
      const settlement = await settleDeliveryAttempt(
        () =>
          input.channelRuntime.sendStreamingChunk(
            input.chatJid,
            safeDelta,
            input.buildStreamingOptions({ done: false }),
          ),
        { scope: 'runtime-streaming-output-live', target: input.chatJid },
      );
      input.applyDeliverySettlement(settlement, {
        streamed: true,
        terminal: false,
      });
    },
    flushBufferedOutput,
    boundedTranscriptSnapshot: () => userVisibleTranscript.snapshot(),
    fullTranscriptSnapshot: () => {
      if (fullUserVisibleTranscriptParts.length === 0) return null;
      return fullUserVisibleTranscriptParts.join('\n').trim() || null;
    },
  };
}
