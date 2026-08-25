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
  let pendingOutputVisible = createRuntimeUserVisibleResultAccumulator();
  let streamSanitizer = createRuntimeUserVisibleStreamSanitizer();
  let pendingOutputRawChars = 0;
  let pendingOutputHasParts = false;
  let pendingNoReplyCandidate: string | null = '';
  let intentionalNoReply = false;

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
      intentionalNoReply = true;
      input.log.info(
        { group: input.groupName, reason },
        'Agent intentionally declined ambient reply',
      );
      return false;
    }
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
      pendingNoReplyCandidate = appendIntentionalNoReplyCandidate(
        pendingNoReplyCandidate,
        raw,
      );
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
    intentionalNoReplyRequested: () => intentionalNoReply,
  };
}
