import type {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import type { RuntimeSettings } from '../../config/settings/runtime-settings.js';
import type {
  isSenderControlAllowed,
  isSenderAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
  shouldDropMessage,
  shouldLogDenied,
} from '../../platform/sender-allowlist.js';
import type {
  RuntimeChatMetadataRepository,
  RuntimeMessageRepository,
} from '../../domain/repositories/ops-repo.js';
import type { Provider } from '../../channels/provider-registry.js';
import type { logger } from '../../infrastructure/logging/logger.js';
import type { RuntimeSecretProvider } from '../../domain/ports/runtime-secret-provider.js';
import type { AppId } from '../../domain/app/app.js';

export type ChannelWiringRepository = RuntimeChatMetadataRepository &
  RuntimeMessageRepository;

export interface RetryTailRecoveryEnqueueInput {
  appId: AppId;
  chatJid: string;
  threadId?: string;
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

export interface DurableOutboundAttemptInput {
  appId: AppId;
  chatJid: string;
  threadId?: string;
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
  shouldDropMessage: typeof shouldDropMessage;
  isSenderAllowed: typeof isSenderAllowed;
  isSenderControlAllowed: typeof isSenderControlAllowed;
  shouldLogDenied: typeof shouldLogDenied;
  logger: Pick<typeof logger, 'info' | 'warn' | 'debug' | 'error'>;
  runtimeSecrets: RuntimeSecretProvider;
}

export interface ChannelWiring {
  describeDestinationJid: (jid: string) => {
    providerId?: string;
    internal: boolean;
    runtimeAppId: AppId;
  };
  connectEnabledChannels: (runtimeSettings: RuntimeSettings) => Promise<void>;
  hasConnectedChannels: () => boolean;
  hasChannel: (jid: string) => boolean;
  supportsStreaming: (jid: string) => boolean;
  supportsProgress: (jid: string) => boolean;
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
  sendStreamingChunk: (
    jid: string,
    rawText: string,
    options?: StreamingChunkOptions,
  ) => Promise<boolean>;
  resetStreaming: (jid: string) => void;
  setTyping: (jid: string, isTyping: boolean) => Promise<void>;
  sendProgressUpdate: (
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ) => Promise<void>;
  syncGroups: (force: boolean) => Promise<void>;
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  isControlApproverAllowed: (input: {
    conversationJid: string;
    userId: string;
    sourceAgentFolder: string;
    decisionPolicy?: 'same_channel';
  }) => Promise<boolean>;
  disconnectChannels: () => Promise<void>;
}
