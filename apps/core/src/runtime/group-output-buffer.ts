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
  resetStreamedTranscriptDeliveryStatus?: () => void;
  /** A generation finished having delivered nothing to the user. */
  onGenerationUndelivered?: (text: string) => void;
  getStreamedTranscriptDeliveryStatus: () => 'none' | 'sent' | 'partially_sent';
  persistCompletedStreamedGeneration?: (
    text: string,
    deliveryStatus: 'sent' | 'partially_sent',
  ) => Promise<void>;
  log: RuntimeLogger;
}) {
  const userVisibleTranscript = createRuntimeResultSummaryAccumulator();
  // Scoped to ONE generation, unlike userVisibleTranscript which spans the run.
  // `text` below is only the delta since the previous flush (the visible
  // accumulator resets on every flush), so persisting it alone would store a
  // multi-chunk reply truncated to its last chunk.
  let generationTranscript = createRuntimeResultSummaryAccumulator();
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
      // Verbatim, no separator: flush boundaries are a transport detail and
      // can fall mid-word, so appending a newline here would store "hel\nlo"
      // for a reply the user received as "hello".
      generationTranscript.append(text);
      if (done) {
        const deliveryStatus = input.getStreamedTranscriptDeliveryStatus();
        const completed = (generationTranscript.snapshot() ?? '').trim();
        if (deliveryStatus !== 'none' && completed) {
          await input.persistCompletedStreamedGeneration?.(
            completed,
            deliveryStatus,
          );
        } else if (completed) {
          // Nothing from this generation reached the user. Hand it to
          // finalization: the run-wide sent flag may already be true from an
          // earlier generation, which would otherwise suppress the fallback.
          input.onGenerationUndelivered?.(completed);
        }
        // Both the text and the delivery accounting belong to the generation
        // that just ended: without these resets the next generation inherits a
        // previous one's transcript and its sent/partially_sent status.
        generationTranscript = createRuntimeResultSummaryAccumulator();
        input.resetStreamedTranscriptDeliveryStatus?.();
      }
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
