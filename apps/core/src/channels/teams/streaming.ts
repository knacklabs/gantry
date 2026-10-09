import type { StreamingChunkResult } from '../../domain/messages/streaming-chunk-result.js';
import {
  isPartialMessageDeliveryError,
  PartialMessageDeliveryError,
} from '../../domain/messages/partial-delivery.js';
import { CHANNEL_STREAM_UPDATE_INTERVAL_MS } from '../channel-provider.js';
import {
  TEAMS_HARD_MESSAGE_BYTES,
  sendTeamsTextMessage,
  splitTeamsTextByByteBudget,
} from './delivery.js';
import { buildTeamsMessageCard } from './cards.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import type {
  MessageDeliveryResult,
  StreamingChunkOptions,
} from '../../domain/types.js';
import type { TeamsSdkClient } from './types.js';
import { TEAMS_SOFT_MESSAGE_BYTES } from './limits.js';

export interface TeamsStreamingState {
  conversationId: string;
  messageId?: string;
  rawBuffer: string;
  lastFlushAt: number;
  pendingDelivery: Promise<StreamingChunkResult>;
}

export async function applyTeamsStreamingChunk(input: {
  jid: string;
  key: string;
  state: TeamsStreamingState;
  text: string;
  options: StreamingChunkOptions;
  activeStreams: Map<string, TeamsStreamingState>;
  sdkClient: TeamsSdkClient;
  markDone: (jid: string, generation?: number) => void;
  shouldContinue: () => boolean;
}): Promise<StreamingChunkResult> {
  const current = input.activeStreams.get(input.key);
  if (current !== input.state) return false;
  if (input.text) input.state.rawBuffer += input.text;
  if (!input.state.rawBuffer.trim() && input.options.done) {
    input.activeStreams.delete(input.key);
    input.markDone(input.jid, input.options.generation);
    return false;
  }

  const now = currentTimeMs();
  const shouldFlush =
    input.options.done ||
    !input.state.messageId ||
    now - input.state.lastFlushAt >= CHANNEL_STREAM_UPDATE_INTERVAL_MS.teams;
  if (!shouldFlush)
    return input.state.messageId
      ? { externalMessageIds: [input.state.messageId] }
      : false;

  let delivered: StreamingChunkResult;
  try {
    delivered = await flushTeamsStreamingState(input);
  } catch (err) {
    if (!input.state.messageId || isPartialMessageDeliveryError(err)) throw err;
    const partial = new PartialMessageDeliveryError({
      cause: err,
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialTeamsStreamDeliveryError',
      message: 'Teams stream partially delivered',
    });
    Object.assign(partial, {
      provider: 'teams',
      externalMessageIds: [input.state.messageId],
    });
    throw partial;
  }
  input.state.lastFlushAt = now;
  if (input.options.done) {
    input.activeStreams.delete(input.key);
    input.markDone(input.jid, input.options.generation);
  }
  return delivered;
}

async function flushTeamsStreamingState(input: {
  jid: string;
  state: TeamsStreamingState;
  options: StreamingChunkOptions;
  sdkClient: TeamsSdkClient;
  shouldContinue: () => boolean;
}): Promise<StreamingChunkResult> {
  const options = input.options;
  const finished = (ids: (string | undefined)[]): StreamingChunkResult => {
    const externalMessageIds = ids.filter((id): id is string => Boolean(id));
    return externalMessageIds.length > 0 ? { externalMessageIds } : true;
  };
  const parts = splitTeamsTextByByteBudget(
    input.state.rawBuffer,
    TEAMS_HARD_MESSAGE_BYTES,
  );
  const headText = parts[0] ?? ' ';
  const hasNativeStreaming =
    input.sdkClient.sendAdaptiveCard && input.sdkClient.updateAdaptiveCard;
  if (!hasNativeStreaming) {
    if (!options.done) return false;
    if (!input.shouldContinue()) return false;
    const sent = await sendTeamsTextMessage(
      input.sdkClient,
      input.state.conversationId,
      input.state.rawBuffer,
      options,
      input.shouldContinue,
    );
    return finished(sent?.externalMessageIds ?? []);
  }

  const card = buildTeamsMessageCard({
    text: headText || ' ',
    targetJid: input.jid,
    threadId: options.threadId,
  });
  if (input.state.messageId) {
    await input.sdkClient.updateAdaptiveCard?.({
      conversationId: input.state.conversationId,
      messageId: input.state.messageId,
      card,
      streamType: 'streaming',
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
  } else {
    const sent = await input.sdkClient.sendAdaptiveCard?.({
      conversationId: input.state.conversationId,
      card,
      streamType: 'informative',
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
    input.state.messageId = sent?.externalMessageId;
  }

  if (!options.done) return finished([input.state.messageId]);
  if (parts.length > 1 && input.shouldContinue()) {
    // ponytail: cap overflow at Teams' provider limit; do not add rolling
    // chunk messages during normal streaming cadence.
    const overflowText = parts.slice(1).join('');
    let overflow: MessageDeliveryResult | void;
    try {
      overflow = await sendTeamsTextMessage(
        input.sdkClient,
        input.state.conversationId,
        overflowText,
        options,
        input.shouldContinue,
      );
    } catch (err) {
      if (!input.state.messageId) throw err;
      const tail = isPartialMessageDeliveryError(err) ? err : undefined;
      const partial = new PartialMessageDeliveryError({
        cause: err,
        deliveredChunks: 1 + (tail?.deliveredChunks ?? 0),
        totalChunks:
          1 +
          (tail?.totalChunks ??
            splitTeamsTextByByteBudget(overflowText, TEAMS_SOFT_MESSAGE_BYTES)
              .length),
        name: 'PartialTeamsStreamDeliveryError',
        message: 'Teams stream partially delivered',
      });
      Object.assign(partial, {
        provider: 'teams',
        externalMessageIds: [
          input.state.messageId,
          ...(tail?.externalMessageIds ?? []),
        ],
        retryTail: tail?.retryTail ?? {
          canonicalText: overflowText,
          providerPayload: {
            provider: 'teams',
            conversationId: input.state.conversationId,
            ...(options.threadId ? { threadId: options.threadId } : {}),
          },
        },
      });
      throw partial;
    }
    return finished([
      input.state.messageId,
      ...(overflow?.externalMessageIds ?? []),
    ]);
  }
  return finished([input.state.messageId]);
}
