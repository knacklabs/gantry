import type { ChannelOpts } from './channel-provider.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import { getProviderRuntimeSecret } from './provider-runtime-secrets.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import type { TeamsAdaptiveCardPayload } from './teams-cards.js';

export const TEAMS_JID_PREFIX = 'teams:';

export interface TeamsChannelCredentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

// Keep Microsoft SDK shapes behind this adapter-owned interface so domain,
// application, and tests do not depend on Bot Framework or Graph SDK types.
export interface TeamsInboundMessage {
  conversationId: string;
  id?: string;
  text?: string;
  name?: string;
  value?: unknown;
  from?: {
    id?: string;
    name?: string;
  };
  senderId?: string;
  senderName?: string;
  timestamp?: string;
  threadId?: string;
  replyToId?: string;
  conversationName?: string;
  conversationType?: string;
  attachments?: TeamsMessageAttachment[];
}

export interface TeamsMessageAttachment {
  id?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface TeamsContextMessage extends TeamsInboundMessage {}

export interface TeamsSdkMessageListInput {
  conversationId: string;
  beforeMessageId?: string;
  limit: number;
}

export interface TeamsSdkMessageGetInput {
  conversationId: string;
  messageId: string;
}

export interface TeamsSdkReplyListInput extends TeamsSdkMessageListInput {
  messageId: string;
}

export interface TeamsSdkStartInput {
  credentials: TeamsChannelCredentials;
  onMessage: (message: TeamsInboundMessage) => Promise<void>;
}

export interface TeamsSdkSendResult {
  externalMessageId?: string;
}

export interface TeamsSdkOutboundMessage {
  conversationId: string;
  text: string;
  threadId?: string;
}

export interface TeamsSdkAdaptiveCardMessage {
  conversationId: string;
  card: TeamsAdaptiveCardPayload;
  threadId?: string;
  streamType?: 'informative' | 'streaming';
}

export interface TeamsSdkAdaptiveCardUpdate {
  conversationId: string;
  messageId: string;
  card: TeamsAdaptiveCardPayload;
  threadId?: string;
  streamType?: 'informative' | 'streaming';
}

export interface TeamsSdkClient {
  start(input: TeamsSdkStartInput): Promise<void>;
  stop(): Promise<void>;
  sendMessage(input: TeamsSdkOutboundMessage): Promise<TeamsSdkSendResult>;
  listChannelMessages?(
    input: TeamsSdkMessageListInput,
  ): Promise<TeamsContextMessage[]>;
  getChannelMessage?(
    input: TeamsSdkMessageGetInput,
  ): Promise<TeamsContextMessage>;
  listChannelMessageReplies?(
    input: TeamsSdkReplyListInput,
  ): Promise<TeamsContextMessage[]>;
  sendAdaptiveCard?(
    input: TeamsSdkAdaptiveCardMessage,
  ): Promise<TeamsSdkSendResult>;
  updateAdaptiveCard?(
    input: TeamsSdkAdaptiveCardUpdate,
  ): Promise<TeamsSdkSendResult>;
}

export interface TeamsChannelDependencies {
  sdkClient?: TeamsSdkClient;
  credentials?: TeamsChannelCredentials;
}

export type TeamsChannelOpts = Pick<
  ChannelOpts,
  | 'onMessage'
  | 'onChatMetadata'
  | 'isControlApproverAllowed'
  | 'onMessageAction'
>;

export interface PendingTeamsPermissionPrompt {
  conversationId: string;
  sourceAgentFolder: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  approvalContextJid?: string;
  request: PermissionApprovalRequest;
  threadId?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: PermissionApprovalDecision) => void;
  settled: boolean;
}

export interface PendingTeamsUserQuestion {
  conversationId: string;
  sourceAgentFolder: string;
  request: UserQuestionRequest;
  threadId?: string;
  messageId?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: UserQuestionResponse) => void;
  settled: boolean;
}

export function normalizeTeamsJid(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const conversationId = trimmed.startsWith(TEAMS_JID_PREFIX)
    ? trimmed.slice(TEAMS_JID_PREFIX.length).trim()
    : trimmed;
  return conversationId ? `${TEAMS_JID_PREFIX}${conversationId}` : null;
}

export function isTeamsJid(input: string): boolean {
  return teamsConversationIdFromJid(input) !== null;
}

export function teamsConversationIdFromJid(jid: string): string | null {
  const trimmed = jid.trim();
  if (!trimmed.startsWith(TEAMS_JID_PREFIX)) return null;
  const conversationId = trimmed.slice(TEAMS_JID_PREFIX.length).trim();
  return conversationId || null;
}

export async function readTeamsCredentials(
  secrets?: RuntimeSecretProvider,
  settings?: {
    providers: Record<string, { defaultConnection?: string } | undefined>;
    providerConnections: Record<
      string,
      { runtimeSecretRefs: Record<string, string | undefined> } | undefined
    >;
  },
): Promise<TeamsChannelCredentials | null> {
  const clientId = await getProviderRuntimeSecret({
    providerId: 'teams',
    key: 'client_id',
    defaultEnvName: 'TEAMS_CLIENT_ID',
    settings,
    secrets,
  });
  const clientSecret = await getProviderRuntimeSecret({
    providerId: 'teams',
    key: 'client_secret',
    defaultEnvName: 'TEAMS_CLIENT_SECRET',
    settings,
    secrets,
  });
  const tenantId = await getProviderRuntimeSecret({
    providerId: 'teams',
    key: 'tenant_id',
    defaultEnvName: 'TEAMS_TENANT_ID',
    settings,
    secrets,
  });
  if (!clientId || !clientSecret || !tenantId) return null;
  return { clientId, clientSecret, tenantId };
}
