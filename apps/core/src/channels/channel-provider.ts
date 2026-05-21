import {
  ChannelLifecyclePort,
  ChannelOwnershipPort,
  AdaptiveCardSink,
  GroupDiscoverySource,
  InteractionSurface,
  MessageSink,
  OnInboundMessage,
  OnChatMetadata,
  NewMessage,
  PlanReviewSurface,
  ProgressSink,
  PermissionApprovalRequest,
  ConversationRoute,
  StreamingSink,
  StreamingStateSink,
  TypingSink,
} from '../domain/types.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings.js';
import type { RuntimeLeasePort } from '../domain/ports/runtime-lease.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  ensureMessageRoute?: (
    chatJid: string,
    message: NewMessage,
  ) => Promise<boolean>;
  onChatMetadata: OnChatMetadata;
  conversationRoutes: () => Record<string, ConversationRoute>;
  runtimeSettings?: () => RuntimeSettings;
  runtimeLease?: RuntimeLeasePort;
  runtimeSecrets?: RuntimeSecretProvider;
  isControlApproverAllowed?: (input: {
    providerId: string;
    conversationJid: string;
    userId: string;
    sourceAgentFolder: string;
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  }) => Promise<boolean>;
}

export type MaybePromise<T> = T | Promise<T>;

export type ChannelAdapter = ChannelLifecyclePort &
  ChannelOwnershipPort &
  MessageSink &
  Partial<
    StreamingSink &
      StreamingStateSink &
      TypingSink &
      AdaptiveCardSink &
      ProgressSink &
      GroupDiscoverySource &
      InteractionSurface &
      PlanReviewSurface
  >;

export type ChannelFactory = (
  opts: ChannelOpts,
) => MaybePromise<ChannelAdapter | null>;
