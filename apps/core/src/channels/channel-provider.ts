import {
  ChannelLifecyclePort,
  ChannelOwnershipPort,
  GroupDiscoverySource,
  InteractionSurface,
  MessageSink,
  OnInboundMessage,
  OnChatMetadata,
  PlanReviewSurface,
  ProgressSink,
  RegisteredGroup,
  StreamingSink,
  StreamingStateSink,
  TypingSink,
} from '../core/types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelAdapter = ChannelLifecyclePort &
  ChannelOwnershipPort &
  MessageSink &
  Partial<
    StreamingSink &
      StreamingStateSink &
      TypingSink &
      ProgressSink &
      GroupDiscoverySource &
      InteractionSurface &
      PlanReviewSurface
  >;

export type ChannelFactory = (opts: ChannelOpts) => ChannelAdapter | null;
