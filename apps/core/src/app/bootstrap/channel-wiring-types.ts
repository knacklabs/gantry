import type {
  MessageDeliveryResult,
  MessageActionCallbackInput,
  OnMemoryReviewMessageAction,
  OnObserverFeedbackMessageAction,
  OnBrainDreamReviewMessageAction,
  MessageSendOptions,
  PermissionApprovalCancellation,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  RichInteractionRequest,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
  UserQuestionCancellation,
} from '../../domain/types.js';
import type { RuntimeSettings } from '../../config/settings/runtime-settings.js';
import type {
  isSenderControlAllowed,
  isSenderAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
  shouldLogDenied,
} from '../../platform/sender-allowlist.js';
import type {
  RuntimeChatMetadataRepository,
  RuntimeMessageRepository,
} from '../../domain/repositories/ops-repo.js';
import type { Provider } from '../../channels/provider-registry.js';
import type { logger } from '../../infrastructure/logging/logger.js';
import type { RuntimeSecretProvider } from '../../domain/ports/runtime-secret-provider.js';
import type { GroupJoinOnboardingCoordinator } from '../../domain/ports/group-join-onboarding.js';
import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type {
  AgentTodoCardStatus,
  AgentTodoRender,
} from '../../domain/ports/task-lifecycle.js';
import type {
  ConversationContextHydrationCoverage,
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
  HydrationRequestObservation,
} from '../../channels/channel-provider.js';
import type {
  ContentCanvasAction,
  ContentCanvasResult,
} from '../../shared/content-canvas.js';
import type { BrainChannelHarvestTap } from '../../brain/brain-channel-harvest.js';
import type {
  HistoricalAttachmentFetcher,
  HistoricalAttachmentFetchResult,
} from '../../domain/ports/historical-attachment-fetcher.js';
import type { MessageAttachmentRepository } from '../../domain/ports/message-attachment-repository.js';
import type {
  ConversationHistoryCoverageRepository,
  ConversationHistoryDistrustEpoch,
} from '../../domain/ports/conversation-history-coverage.js';

export type ChannelWiringRepository = RuntimeChatMetadataRepository &
  RuntimeMessageRepository;

export interface RetryTailRecoveryEnqueueInput {
  appId: AppId;
  chatJid: string;
  threadId?: string;
  providerAccountId?: string;
  sourceMessageId: string;
  provider: string;
  retryTail: {
    canonicalText: string;
    providerPayload?: unknown;
  };
}

export type RetryTailRecoveryEnqueue = (
  input: RetryTailRecoveryEnqueueInput,
) => Promise<void>;

export type ChannelAccountOptions = {
  providerAccountId?: string;
  threadId?: string;
};
export type ChannelStreamResetOptions = ChannelAccountOptions & {
  threadId?: string;
};

export interface DurableOutboundAttemptInput {
  appId: AppId;
  chatJid: string;
  threadId?: string;
  providerAccountId?: string;
  sourceMessageId: string;
  provider: string;
  canonicalText: string;
}

export interface DurableOutboundAttempt {
  settleSent: (input: {
    sentAt: string;
    providerMessageId?: string;
    providerPayload?: unknown;
  }) => Promise<void>;
  settleFailed: (input: { failedAt: string; error: string }) => Promise<void>;
  settlePartiallyDelivered: (input: {
    partialAt: string;
    error: string;
    deliveredParts?: number;
    totalParts?: number;
    retryTail?: {
      canonicalText: string;
      providerPayload?: unknown;
    };
  }) => Promise<void>;
}

export type DurableOutboundAttemptFactory = (
  input: DurableOutboundAttemptInput,
) => Promise<DurableOutboundAttempt>;

declare const recoveryDispatchPermitBrand: unique symbol;

export interface RecoveryDispatchPermitInput {
  deliveryId: string;
  itemId: string;
  destinationJid: string;
  canonicalText: string;
  threadId?: string;
}

export type RecoveryDispatchPermit = RecoveryDispatchPermitInput & {
  readonly [recoveryDispatchPermitBrand]: true;
};

export interface ChannelWiringDeps {
  appId: AppId;
  providerIds: readonly Provider[];
  opsRepository?: ChannelWiringRepository;
  loadSenderAllowlist: typeof loadSenderAllowlist;
  loadSenderControlAllowlist: typeof loadSenderControlAllowlist;
  isSenderAllowed: typeof isSenderAllowed;
  isSenderControlAllowed: typeof isSenderControlAllowed;
  shouldLogDenied: typeof shouldLogDenied;
  logger: Pick<typeof logger, 'info' | 'warn' | 'debug' | 'error'>;
  runtimeSecrets: RuntimeSecretProvider;
  groupJoinOnboarding?: GroupJoinOnboardingCoordinator;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown>;
  brainHarvestTap?: BrainChannelHarvestTap;
  historyCoverage?: ConversationHistoryCoverageRepository;
  messageAttachments?: MessageAttachmentRepository;
}

export interface ChannelWiring {
  getRuntimeAppId: () => AppId;
  normalizeProviderId: (providerId: string) => string;
  getHistoryCoverageDistrustEpoch: (
    providerAccountId: string,
  ) => ConversationHistoryDistrustEpoch;
  describeDestinationJid: (jid: string) => {
    providerId?: string;
    internal: boolean;
    runtimeAppId: AppId;
  };
  connectEnabledChannels: (
    runtimeSettings: RuntimeSettings,
    options?: { providerInbound?: boolean },
  ) => Promise<void>;
  hasConnectedChannels: () => boolean;
  hasChannel: (jid: string, options?: ChannelAccountOptions) => boolean;
  supportsStreaming: (
    jid: string,
    options?: { providerAccountId?: string },
  ) => boolean;
  supportsProgress: (
    jid: string,
    options?: { providerAccountId?: string },
  ) => boolean;
  fetchHistoricalAttachment: (
    input: Parameters<
      HistoricalAttachmentFetcher['fetchHistoricalAttachment']
    >[0],
  ) => Promise<HistoricalAttachmentFetchResult>;
  getMessageAttachmentRepository: () => MessageAttachmentRepository;
  sendMessage: (
    jid: string,
    rawText: string,
    options: {
      durability: 'required' | 'best_effort';
      throwOnMissing?: boolean;
      messageOptions?: MessageSendOptions;
    },
  ) => Promise<void>;
  sendProviderMessage: (
    jid: string,
    rawText: string,
    options: {
      permit: RecoveryDispatchPermit;
      throwOnMissing?: boolean;
      messageOptions?: MessageSendOptions;
    },
  ) => Promise<MessageDeliveryResult | undefined>;
  createRecoveryDispatchPermit: (
    input: RecoveryDispatchPermitInput,
  ) => RecoveryDispatchPermit;
  setRetryTailRecoveryEnqueue: (
    enqueue: RetryTailRecoveryEnqueue | undefined,
  ) => void;
  setDurableOutboundAttemptFactory: (
    factory: DurableOutboundAttemptFactory | undefined,
  ) => void;
  setRuntimeSecrets: (provider: RuntimeSecretProvider) => void;
  setMessageActionHandler: (
    handler: ((input: MessageActionCallbackInput) => Promise<void>) | undefined,
  ) => void;
  setMemoryReviewMessageActionHandler: (
    handler: OnMemoryReviewMessageAction | undefined,
  ) => void;
  setObserverFeedbackMessageActionHandler: (
    handler: OnObserverFeedbackMessageAction | undefined,
  ) => void;
  setBrainDreamReviewMessageActionHandler: (
    handler: OnBrainDreamReviewMessageAction | undefined,
  ) => void;
  sendStreamingChunk: (
    jid: string,
    rawText: string,
    options?: StreamingChunkOptions,
  ) => Promise<boolean>;
  resetStreaming: (jid: string, options?: ChannelStreamResetOptions) => void;
  setTyping: (
    jid: string,
    isTyping: boolean,
    options?: ChannelAccountOptions,
  ) => Promise<void>;
  progressCardIdentity?: (
    jid: string,
    options?: ProgressUpdateOptions,
  ) => string | undefined;
  sendProgressUpdate: (
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ) => Promise<void | boolean>;
  addReaction: (
    jid: string,
    messageRef: string,
    emoji: string,
    options?: ChannelAccountOptions,
  ) => Promise<void>;
  removeReaction: (
    jid: string,
    messageRef: string,
    emoji: string,
    options?: ChannelAccountOptions,
  ) => Promise<void>;
  reactionRemovalMode: (
    jid: string,
    options?: Pick<ChannelAccountOptions, 'providerAccountId'>,
  ) => 'exact' | 'all' | undefined;
  syncGroups: (force: boolean) => Promise<void>;
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  cancelPermissionApproval: (
    cancellation: PermissionApprovalCancellation,
  ) => Promise<'settled' | 'queued' | 'not_found'>;
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  cancelUserQuestion: (
    cancellation: UserQuestionCancellation,
  ) => Promise<'settled' | 'queued' | 'not_found'>;
  renderAgentTodo: (
    jid: string,
    render: AgentTodoRender,
    options?: ChannelAccountOptions,
  ) => Promise<boolean>;
  renderRichInteraction: (
    jid: string,
    request: RichInteractionRequest,
    options?: ChannelAccountOptions,
  ) => Promise<boolean>;
  executeContentCanvasAction: (
    jid: string,
    action: ContentCanvasAction,
    options?: ChannelAccountOptions,
  ) => Promise<ContentCanvasResult>;
  hydrateConversationContext?: (
    request: ConversationContextHydrationRequest,
  ) => Promise<ConversationContextHydrationResult>;
  finalizeAgentTodo: (
    jid: string,
    input: {
      threadId?: string | null;
      cardKind?: AgentTodoRender['cardKind'];
      status: AgentTodoCardStatus;
    },
    options?: ChannelAccountOptions,
  ) => Promise<boolean>;
  isControlApproverAllowed: (input: {
    conversationJid: string;
    providerAccountId?: string;
    agentId?: string;
    userId: string;
    sourceAgentFolder: string;
    decisionPolicy?: 'same_channel';
  }) => Promise<boolean>;
  disconnectChannels: () => Promise<void>;
}

export type {
  ConversationContextHydrationCoverage,
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
  HydrationRequestObservation,
};
