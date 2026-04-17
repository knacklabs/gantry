import {
  GroupDiscoverySource,
  InteractionSurface,
  ProgressSink,
  StreamingSink,
  StreamingStateSink,
  TypingSink,
} from '../core/types.js';
import { ChannelAdapter } from '../channels/channel-provider.js';

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

export function asGroupDiscoverySource(
  channel: ChannelAdapter,
): GroupDiscoverySource | undefined {
  return typeof channel.syncGroups === 'function'
    ? (channel as unknown as GroupDiscoverySource)
    : undefined;
}

export function asPermissionApprovalSurface(
  channel: ChannelAdapter,
): Pick<InteractionSurface, 'requestPermissionApproval'> | undefined {
  return typeof channel.requestPermissionApproval === 'function'
    ? (channel as unknown as Pick<
        InteractionSurface,
        'requestPermissionApproval'
      >)
    : undefined;
}

export function asUserQuestionSurface(
  channel: ChannelAdapter,
): Pick<InteractionSurface, 'requestUserAnswer'> | undefined {
  return typeof channel.requestUserAnswer === 'function'
    ? (channel as unknown as Pick<InteractionSurface, 'requestUserAnswer'>)
    : undefined;
}
