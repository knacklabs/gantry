import {
  GroupDiscoverySource,
  InteractionSurface,
  MessageReactionSink,
  ProgressSink,
  RichInteractionSurface,
  StreamingSink,
  StreamingStateSink,
  TypingSink,
} from '../../domain/types.js';
import { ChannelAdapter } from '../../channels/channel-provider.js';
import type { AgentTodoSink } from '../../domain/ports/task-lifecycle.js';
import type { ContentCanvasSurface } from '../../shared/content-canvas.js';

export function asTypingSink(channel: ChannelAdapter): TypingSink | undefined {
  return typeof channel.setTyping === 'function'
    ? (channel as unknown as TypingSink)
    : undefined;
}

export function asStreamingSink(
  channel: ChannelAdapter,
): StreamingSink | undefined {
  return typeof channel.sendStreamingChunk === 'function'
    ? (channel as unknown as StreamingSink)
    : undefined;
}

export function asStreamingStateSink(
  channel: ChannelAdapter,
): StreamingStateSink | undefined {
  return typeof channel.resetStreaming === 'function'
    ? (channel as unknown as StreamingStateSink)
    : undefined;
}

export function asProgressSink(
  channel: ChannelAdapter,
): ProgressSink | undefined {
  return typeof channel.sendProgressUpdate === 'function'
    ? (channel as unknown as ProgressSink)
    : undefined;
}

export function asMessageReactionSink(
  channel: ChannelAdapter,
): MessageReactionSink | undefined {
  return typeof channel.addReaction === 'function'
    ? (channel as unknown as MessageReactionSink)
    : undefined;
}

export function asGroupDiscoverySource(
  channel: ChannelAdapter,
): GroupDiscoverySource | undefined {
  return typeof channel.syncGroups === 'function'
    ? (channel as unknown as GroupDiscoverySource)
    : undefined;
}

export function asPermissionApprovalSurface(
  channel: ChannelAdapter,
):
  | Pick<
      InteractionSurface,
      | 'requestPermissionApproval'
      | 'dropPendingInteraction'
      | 'cancelPendingPermission'
    >
  | undefined {
  return typeof channel.requestPermissionApproval === 'function'
    ? (channel as unknown as Pick<
        InteractionSurface,
        | 'requestPermissionApproval'
        | 'dropPendingInteraction'
        | 'cancelPendingPermission'
      >)
    : undefined;
}

export function asUserQuestionSurface(
  channel: ChannelAdapter,
):
  | Pick<
      InteractionSurface,
      | 'requestUserAnswer'
      | 'questionIndexesForDeliveredPrompt'
      | 'dropPendingInteraction'
      | 'cancelPendingQuestion'
    >
  | undefined {
  return typeof channel.requestUserAnswer === 'function'
    ? (channel as unknown as Pick<
        InteractionSurface,
        | 'requestUserAnswer'
        | 'questionIndexesForDeliveredPrompt'
        | 'dropPendingInteraction'
        | 'cancelPendingQuestion'
      >)
    : undefined;
}

export function asRichInteractionSurface(
  channel: ChannelAdapter,
): RichInteractionSurface | undefined {
  return typeof channel.renderRichInteraction === 'function'
    ? (channel as unknown as RichInteractionSurface)
    : undefined;
}

export function asAgentTodoSurface(
  channel: ChannelAdapter,
): AgentTodoSink | undefined {
  return typeof channel.renderAgentTodo === 'function'
    ? (channel as unknown as AgentTodoSink)
    : undefined;
}

export function asContentCanvasSurface(
  channel: ChannelAdapter,
): ContentCanvasSurface | undefined {
  return typeof (channel as unknown as Partial<ContentCanvasSurface>)
    .executeCanvasAction === 'function'
    ? (channel as unknown as ContentCanvasSurface)
    : undefined;
}
