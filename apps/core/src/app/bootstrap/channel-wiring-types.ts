import type {
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
  asRemoteControlCommand,
  handleRemoteControlCommand,
} from '../../runtime/remote-control-command.js';
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
  asRemoteControlCommand: typeof asRemoteControlCommand;
  handleRemoteControlCommand: typeof handleRemoteControlCommand;
  logger: Pick<typeof logger, 'info' | 'warn' | 'debug' | 'error'>;
  runtimeSecrets: RuntimeSecretProvider;
}

export interface ChannelWiring {
  connectEnabledChannels: (runtimeSettings: RuntimeSettings) => Promise<void>;
  hasConnectedChannels: () => boolean;
  hasChannel: (jid: string) => boolean;
  supportsStreaming: (jid: string) => boolean;
  supportsProgress: (jid: string) => boolean;
  sendMessage: (
    jid: string,
    rawText: string,
    options?: { throwOnMissing?: boolean; messageOptions?: MessageSendOptions },
  ) => Promise<void>;
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
  disconnectChannels: () => Promise<void>;
}
