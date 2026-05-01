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
} from '../domain/types.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings.js';
import type { RuntimeLeasePort } from '../domain/ports/runtime-lease.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  runtimeSettings?: () => RuntimeSettings;
  runtimeLease?: RuntimeLeasePort;
  runtimeSecrets?: RuntimeSecretProvider;
}

export type MaybePromise<T> = T | Promise<T>;

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

export type ChannelFactory = (
  opts: ChannelOpts,
) => MaybePromise<ChannelAdapter | null>;
