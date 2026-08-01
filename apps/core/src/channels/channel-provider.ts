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
import type { GroupJoinOnboardingCoordinator } from '../domain/ports/group-join-onboarding.js';
import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
} from '../domain/ports/conversation-context-hydration.js';
import type { InboundAttachmentReader } from '../shared/inbound-attachment-writer.js';

export type {
  ConversationContextHydrationCoverage,
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
  HydrationRequestObservation,
} from '../domain/ports/conversation-context-hydration.js';

export const CHANNEL_STREAM_UPDATE_INTERVAL_MS = {
  slack: 550,
  telegram: 950,
  teams: 1800,
  discord: 1200,
} as const;

export type InboundMessageDeliveryResult = 'stored' | 'dropped';

export class InboundMessageDeliveryError extends Error {
  readonly name = 'InboundMessageDeliveryError';

  constructor(
    readonly failures: readonly unknown[],
    readonly stored: boolean,
  ) {
    super('Inbound message persistence failed');
  }
}

export type MaterializedProviderAttachment = {
  storageRef: string;
  reclaim: () => Promise<void>;
};

export type MaterializeProviderAttachment = (input: {
  fileName: string;
  content: InboundAttachmentReader & {
    cancel(reason?: unknown): Promise<void>;
  };
}) => Promise<MaterializedProviderAttachment>;

export interface MessageAttachmentsDeleted {
  providerId: string;
  providerAccountIds?: readonly string[];
  conversationJid: string;
  threadId?: string;
  externalMessageIds: readonly string[];
  deletedAt: string;
}

export interface ChannelOpts {
  appId?: string;
  providerAccountId?: string;
  inboundProviderAccountIds?: string[];
  agentId?: string;
  onMessage: (
    ...args: Parameters<OnInboundMessage>
  ) => Promise<InboundMessageDeliveryResult>;
  ensureMessageRoute?: (
    chatJid: string,
    message: NewMessage,
  ) => Promise<boolean>;
  materializeProviderAttachment?: MaterializeProviderAttachment;
  onMessageAttachmentsDeleted?: (
    input: MessageAttachmentsDeleted,
  ) => Promise<void>;
  onChatMetadata: OnChatMetadata;
  onMessageAction?: OnMessageAction;
  conversationRoutes: () => Record<string, ConversationRoute>;
  runtimeSettings?: () => RuntimeSettings;
  runtimeLease?: RuntimeLeasePort;
  runtimeSecrets?: RuntimeSecretProvider;
  groupJoinOnboarding?: GroupJoinOnboardingCoordinator;
  distrustHistoryCoverage?: (providerAccountIds: readonly string[]) => void;
  setHistoryCoverageInboundActive?: (
    providerAccountIds: readonly string[],
    active: boolean,
  ) => void;
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
  MessageSink & { reportsHistoryCoverageInboundLiveness?: boolean } & Partial<
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
