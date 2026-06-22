import {
  ChannelLifecyclePort,
  ChannelOwnershipPort,
  GroupDiscoverySource,
  InteractionSurface,
  MessageSink,
  OnInboundMessage,
  OnChatMetadata,
  NewMessage,
  OnMessageAction,
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
import type { AgentTodoSink } from '../domain/ports/task-lifecycle.js';

export interface ChannelOpts {
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
      ProgressSink &
      GroupDiscoverySource &
      InteractionSurface &
      PlanReviewSurface &
      AgentTodoSink
  >;

export type ChannelFactory = (
  opts: ChannelOpts,
) => MaybePromise<ChannelAdapter | null>;
