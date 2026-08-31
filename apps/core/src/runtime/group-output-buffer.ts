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

const INTENTIONAL_NO_REPLY_MARKER = '<internal>GANTRY_NO_REPLY</internal>';
const MAX_NO_REPLY_CANDIDATE_CHARS = INTENTIONAL_NO_REPLY_MARKER.length + 32;

function appendIntentionalNoReplyCandidate(
  candidate: string | null,
  raw: string,
): string | null {
  if (candidate === null) return null;
  const next = candidate + raw;
  return next.length <= MAX_NO_REPLY_CANDIDATE_CHARS ? next : null;
}

function isIntentionalNoReplyCandidate(candidate: string | null): boolean {
  return candidate?.trim() === INTENTIONAL_NO_REPLY_MARKER;
}

type RuntimeLogger = {
  info(input: unknown, message: string): void;
  warn(input: unknown, message: string): void;
};

export function createGroupOutputBuffer(input: {
  channelRuntime: GroupProcessingDeps['channelRuntime'];
  chatJid: string;
  groupName: string;
  supportsStreamingChunks: boolean;
  allowIntentionalNoReply?: boolean;
  onIntentionalNoReply?: () => void;
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
  onVisibleDeliveryStart?: () => Promise<void> | void;
  onVisibleDeliveryFinish?: (delivered: boolean) => Promise<void> | void;
  resetStreamedTranscriptDeliveryStatus?: () => void;
  /** A generation finished having delivered nothing to the user. */
  onGenerationUndelivered?: (text: string) => void;
  getStreamedTranscriptDeliveryStatus: () => 'none' | 'sent' | 'partially_sent';
  persistCompletedStreamedGeneration?: (
    text: string,
    deliveryStatus: 'sent' | 'partially_sent' | 'failed',
  ) => Promise<void>;
  log: RuntimeLogger;
}) {
  const userVisibleTranscript = createRuntimeResultSummaryAccumulator();
  // Scoped to ONE generation, unlike userVisibleTranscript which spans the run.
  // `text` below is only the delta since the previous flush (the visible
  // accumulator resets on every flush), so persisting it alone would store a
  // multi-chunk reply truncated to its last chunk.
  //
  // Plain accumulation, NOT createRuntimeResultSummaryAccumulator: that one is
  // the bounded 4k summary used for `boundedTranscript`, and it keeps only the
  // tail. Persisting a durable message through it would silently truncate any
  // reply the user received in full. Held only until the generation completes.
  let generationParts: string[] = [];
  let pendingOutputVisible = createRuntimeUserVisibleResultAccumulator();
  let streamSanitizer = createRuntimeUserVisibleStreamSanitizer();
  let pendingOutputRawChars = 0;
  let pendingOutputHasParts = false;
  let pendingNoReplyCandidate: string | null = '';
  let intentionalNoReply = false;

  const acceptIntentionalNoReply = (reason: string) => {
    if (intentionalNoReply) return;
    intentionalNoReply = true;
    input.log.info(
      { group: input.groupName, reason },
      'Agent intentionally declined ambient reply',
    );
    input.onIntentionalNoReply?.();
  };

  const runVisibleDelivery = async (
    attempt: () => Promise<DeliverySettlement>,
    options: { streamed: boolean; terminal: boolean },
  ): Promise<DeliverySettlement> => {
    await Promise.resolve(input.onVisibleDeliveryStart?.()).catch((err) =>
      input.log.warn(
        { err, group: input.groupName },
        'Visible output progress ordering failed',
      ),
    );
    let settlement: DeliverySettlement = 'not_delivered';
    try {
      settlement = await attempt();
      input.applyDeliverySettlement(settlement, options);
      return settlement;
    } finally {
      await Promise.resolve(
        input.onVisibleDeliveryFinish?.(settlement !== 'not_delivered'),
      ).catch((err) =>
        input.log.warn(
          { err, group: input.groupName },
          'Visible output completion hook failed',
        ),
      );
    }
  };

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
    const noReplyRequested =
      input.allowIntentionalNoReply &&
      isIntentionalNoReplyCandidate(pendingNoReplyCandidate);
    pendingOutputVisible = createRuntimeUserVisibleResultAccumulator();
    streamSanitizer = createRuntimeUserVisibleStreamSanitizer();
    pendingOutputRawChars = 0;
    pendingOutputHasParts = false;
    pendingNoReplyCandidate = '';
    if (noReplyRequested) {
      acceptIntentionalNoReply(reason);
      generationParts = [];
      input.resetStreamedTranscriptDeliveryStatus?.();
      return false;
    }
    const text = visibleOutput ? formatOutboundForChannel(visibleOutput) : '';
    input.log.info(
      { group: input.groupName },
      `Agent output: ${rawChars} chars`,
    );
    if (!text) return false;
    if (input.supportsStreamingChunks) {
      const settlement = await runVisibleDelivery(
        () =>
          settleDeliveryAttempt(
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
          }),
        { streamed: true, terminal },
      );
      // Verbatim, no separator: flush boundaries are a transport detail and
      // can fall mid-word, so appending a newline here would store "hel\nlo"
      // for a reply the user received as "hello".
      generationParts.push(text);
      if (done) {
        const deliveryStatus = input.getStreamedTranscriptDeliveryStatus();
        const completed = generationParts.join('').trim();
        // Durability is a contract of this path, so say what it decided:
        // silence here is why a missing assistant row could not be diagnosed
        // from a CI log.
        input.log.info(
          {
            group: input.groupName,
            reason,
            deliveryStatus,
            completedChars: completed.length,
            willPersist: completed.length > 0,
          },
          'Streamed generation persistence decision',
        );
        if (completed) {
          // Persist what the assistant PRODUCED, and record what happened to it
          // in delivery_status — rather than skipping the row when nothing was
          // delivered. Skipping loses the reply entirely: transports that
          // acknowledge asynchronously (the app channel emits events rather
          // than confirming a send) leave the status at 'none', so the message
          // never reached /messages at all.
          await input.persistCompletedStreamedGeneration?.(
            completed,
            deliveryStatus === 'none' ? 'failed' : deliveryStatus,
          );
          if (deliveryStatus === 'none') {
            // Also offer it to finalization's fallback: the run-wide sent flag
            // may already be true from an earlier generation, which would
            // otherwise suppress a re-send to the user.
            input.onGenerationUndelivered?.(completed);
          }
        }
        // Both the text and the delivery accounting belong to the generation
        // that just ended: without these resets the next generation inherits a
        // previous one's transcript and its sent/partially_sent status.
        generationParts = [];
        input.resetStreamedTranscriptDeliveryStatus?.();
      }
    } else {
      const messageOptions = await input.buildMessageOptions();
      await runVisibleDelivery(
        () =>
          settleDeliveryAttempt(
            () => input.sendMessageToChannel(text, messageOptions),
            { scope: 'runtime-output-message-final', target: input.chatJid },
          ),
        { streamed: false, terminal },
      );
    }
    userVisibleTranscript.append(`${text}\n`);
    return true;
  };

  return {
    appendRawOutput: async (raw: string) => {
      pendingOutputHasParts = true;
      pendingOutputRawChars += raw.length;
      pendingNoReplyCandidate = appendIntentionalNoReplyCandidate(
        pendingNoReplyCandidate,
        raw,
      );
      if (
        input.allowIntentionalNoReply &&
        isIntentionalNoReplyCandidate(pendingNoReplyCandidate)
      ) {
        acceptIntentionalNoReply('output-complete');
      }
      pendingOutputVisible.append(raw);
      if (!input.supportsStreamingChunks) return;
      const safeDelta = streamSanitizer.append(raw);
      if (!safeDelta) return;
      await runVisibleDelivery(
        () =>
          settleDeliveryAttempt(
            () =>
              input.channelRuntime.sendStreamingChunk(
                input.chatJid,
                safeDelta,
                input.buildStreamingOptions({ done: false }),
              ),
            { scope: 'runtime-streaming-output-live', target: input.chatJid },
          ),
        { streamed: true, terminal: false },
      );
    },
    flushBufferedOutput,
    transcriptSnapshot: () => userVisibleTranscript.snapshot(),
    intentionalNoReplyRequested: () => intentionalNoReply,
  };
}
