import {
  ChannelLifecyclePort,
  ChannelOwnershipPort,
  GroupDiscoverySource,
  InteractionSurface,
  MessageReactionSink,
  MessageSink,
  OnInboundMessage,
  OnChatMetadata,
  NewMessage,
  OnMessageAction,
  PlanReviewSurface,
  ProgressSink,
  PermissionApprovalRequest,
  ConversationRoute,
  RichInteractionSurface,
  StreamingSink,
  StreamingStateSink,
  TypingSink,
} from '../domain/types.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings.js';
import type { RuntimeLeasePort } from '../domain/ports/runtime-lease.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import type { AgentTodoSink } from '../domain/ports/task-lifecycle.js';
import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
} from '../domain/ports/conversation-context-hydration.js';

export type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
} from '../domain/ports/conversation-context-hydration.js';

export const CHANNEL_STREAM_UPDATE_INTERVAL_MS = {
  slack: 550,
  telegram: 950,
  teams: 1800,
  discord: 1200,
} as const;

export interface ChannelOpts {
  appId?: string;
  providerAccountId?: string;
  inboundProviderAccountIds?: string[];
  agentId?: string;
  onMessage: OnInboundMessage;
  ensureMessageRoute?: (
    chatJid: string,
    message: NewMessage,
  ) => Promise<boolean>;
  onChatMetadata: OnChatMetadata;
  onMessageAction?: OnMessageAction;
  conversationRoutes: () => Record<string, ConversationRoute>;
  runtimeSettings?: () => RuntimeSettings;
  runtimeLease?: RuntimeLeasePort;
  runtimeSecrets?: RuntimeSecretProvider;
  isControlApproverAllowed?: (input: {
    providerId: string;
    providerAccountId?: string;
    agentId?: string;
    conversationJid: string;
    threadId?: string;
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
      ProgressSink &
      MessageReactionSink &
      GroupDiscoverySource &
      InteractionSurface &
      RichInteractionSurface &
      PlanReviewSurface &
      AgentTodoSink &
      ConversationContextHydrationSink
  >;

export interface ConversationContextHydrationSink {
  hydrateConversationContext(
    request: ConversationContextHydrationRequest,
  ): Promise<ConversationContextHydrationResult>;
}

export type ChannelFactory = (
  opts: ChannelOpts,
) => MaybePromise<ChannelAdapter | null>;
