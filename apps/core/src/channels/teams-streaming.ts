import { CHANNEL_STREAM_UPDATE_INTERVAL_MS } from './channel-provider.js';
import {
  TEAMS_HARD_MESSAGE_BYTES,
  sendTeamsTextMessage,
  splitTeamsTextByByteBudget,
} from './teams-delivery.js';
import { buildTeamsMessageCard } from './teams-cards.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import type { StreamingChunkOptions } from '../domain/types.js';
import type { TeamsSdkClient } from './teams-types.js';

export interface TeamsStreamingState {
  conversationId: string;
  messageId?: string;
  rawBuffer: string;
  lastFlushAt: number;
  pendingDelivery: Promise<boolean>;
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
}): Promise<boolean> {
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
  if (!shouldFlush) return Boolean(input.state.messageId);

  const delivered = await flushTeamsStreamingState(input);
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
}): Promise<boolean> {
  const options = input.options;
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
    await sendTeamsTextMessage(
      input.sdkClient,
      input.state.conversationId,
      input.state.rawBuffer,
      options,
      input.shouldContinue,
    );
    return true;
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

  if (options.done && parts.length > 1) {
    if (!input.shouldContinue()) return true;
    // ponytail: cap overflow at Teams' provider limit; do not add rolling
    // chunk messages during normal streaming cadence.
    await sendTeamsTextMessage(
      input.sdkClient,
      input.state.conversationId,
      parts.slice(1).join(''),
      options,
      input.shouldContinue,
    );
  }
  return true;
}
