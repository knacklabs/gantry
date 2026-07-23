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
    MessageSendOptions | undefined | Promise<MessageSendOptions | undefined>;
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
  let pendingOutputVisible = createRuntimeUserVisibleResultAccumulator();
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
    const visibleOutput = pendingOutputVisible.snapshot();
    const finalStreamDelta = streamSanitizer.finish();
    const rawChars = pendingOutputRawChars;
    pendingOutputVisible = createRuntimeUserVisibleResultAccumulator();
    streamSanitizer = createRuntimeUserVisibleStreamSanitizer();
    pendingOutputRawChars = 0;
    pendingOutputHasParts = false;
    const text = visibleOutput ? formatOutboundForChannel(visibleOutput) : '';
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
    userVisibleTranscript.append(`${text}\n`);
    return true;
  };

  return {
    appendRawOutput: async (raw: string) => {
      pendingOutputHasParts = true;
      pendingOutputRawChars += raw.length;
      pendingOutputVisible.append(raw);
      if (!input.supportsStreamingChunks) return;
      const safeDelta = streamSanitizer.append(raw);
      if (!safeDelta) return;
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
    transcriptSnapshot: () => userVisibleTranscript.snapshot(),
  };
}
