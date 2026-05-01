import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import type {
  MessageSendOptions,
  NewMessage,
  PermissionApprovalRequest,
} from '../domain/types.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import { logger } from '../infrastructure/logging/logger.js';

export const TEAMS_JID_PREFIX = 'teams:';
export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE =
  'application/vnd.microsoft.card.adaptive';

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
}

export interface TeamsSdkClient {
  start(input: TeamsSdkStartInput): Promise<void>;
  stop(): Promise<void>;
  sendMessage(input: TeamsSdkOutboundMessage): Promise<TeamsSdkSendResult>;
  sendAdaptiveCard?(
    input: TeamsSdkAdaptiveCardMessage,
  ): Promise<TeamsSdkSendResult>;
}

export interface TeamsChannelDependencies {
  sdkClient?: TeamsSdkClient;
  credentials?: TeamsChannelCredentials;
}

export interface TeamsAdaptiveCardAction {
  type: 'Action.Execute';
  title: string;
  verb: string;
  data: {
    action: 'permission_decision';
    requestId: string;
    decision: 'approve' | 'deny';
    sourceGroup: string;
    targetJid?: string;
    threadId?: string;
  };
}

export interface TeamsAdaptiveCardPayload {
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json';
  type: 'AdaptiveCard';
  version: '1.5';
  body: Array<Record<string, unknown>>;
  actions: TeamsAdaptiveCardAction[];
}

export interface TeamsAdaptiveCardDescriptorPayload {
  attachments: [
    {
      contentType: typeof TEAMS_ADAPTIVE_CARD_CONTENT_TYPE;
      content: TeamsAdaptiveCardPayload;
    },
  ];
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

export function buildTeamsApprovalAdaptiveCard(
  request: PermissionApprovalRequest,
): TeamsAdaptiveCardPayload {
  const title =
    request.title ||
    request.displayName ||
    `${request.toolName} permission request`;
  const facts = [
    { title: 'Source', value: request.sourceGroup },
    { title: 'Tool', value: request.toolName },
    request.threadId ? { title: 'Thread', value: request.threadId } : null,
    request.decisionReason
      ? { title: 'Reason', value: request.decisionReason }
      : null,
    request.blockedPath ? { title: 'Path', value: request.blockedPath } : null,
  ].filter(
    (entry): entry is { title: string; value: string } => entry !== null,
  );

  const command =
    typeof request.toolInput?.command === 'string'
      ? request.toolInput.command
      : undefined;
  const body: Array<Record<string, unknown>> = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: title,
      wrap: true,
    },
    {
      type: 'FactSet',
      facts,
    },
  ];

  if (request.description) {
    body.push({
      type: 'TextBlock',
      text: request.description,
      wrap: true,
    });
  }
  if (command) {
    body.push({
      type: 'TextBlock',
      text: `Command: \`${command}\``,
      wrap: true,
      fontType: 'Monospace',
    });
  }

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
    actions: [
      {
        type: 'Action.Execute',
        title: 'Approve',
        verb: 'myclaw.permission.approve',
        data: {
          action: 'permission_decision',
          requestId: request.requestId,
          decision: 'approve',
          sourceGroup: request.sourceGroup,
          targetJid: request.targetJid,
          threadId: request.threadId,
        },
      },
      {
        type: 'Action.Execute',
        title: 'Deny',
        verb: 'myclaw.permission.deny',
        data: {
          action: 'permission_decision',
          requestId: request.requestId,
          decision: 'deny',
          sourceGroup: request.sourceGroup,
          targetJid: request.targetJid,
          threadId: request.threadId,
        },
      },
    ],
  };
}

export function buildTeamsApprovalDescriptorPayload(
  request: PermissionApprovalRequest,
): TeamsAdaptiveCardDescriptorPayload {
  return {
    attachments: [
      {
        contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
        content: buildTeamsApprovalAdaptiveCard(request),
      },
    ],
  };
}

export class TeamsChannel implements ChannelAdapter {
  name = 'teams';

  private connected = false;

  constructor(
    private readonly credentials: TeamsChannelCredentials,
    private readonly opts: Pick<ChannelOpts, 'onMessage' | 'onChatMetadata'>,
    private readonly sdkClient: TeamsSdkClient,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.sdkClient.start({
      credentials: this.credentials,
      onMessage: (message) => this.ingestMessage(message),
    });
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.sdkClient.stop();
    this.connected = false;
  }

  ownsJid(jid: string): boolean {
    return isTeamsJid(jid);
  }

  async sendMessage(
    jid: string,
    text: string,
    options: MessageSendOptions = {},
  ): Promise<TeamsSdkSendResult | void> {
    if (!this.connected) return;
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId) return;
    return await this.sdkClient.sendMessage({
      conversationId,
      text,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
  }

  async ingestMessage(message: TeamsInboundMessage): Promise<void> {
    const jid = normalizeTeamsJid(message.conversationId);
    if (!jid) return;

    const timestamp = message.timestamp || new Date().toISOString();
    const sender = message.senderId || message.from?.id || 'unknown';
    const senderName = message.senderName || message.from?.name || sender;
    const content = message.text?.trim() || '';
    if (!content) return;

    await this.opts.onChatMetadata(
      jid,
      timestamp,
      message.conversationName,
      'teams',
      message.conversationType !== 'personal',
    );

    const normalized: NewMessage = {
      id: message.id || `teams:${message.conversationId}:${timestamp}`,
      chat_jid: jid,
      channel_provider: 'teams',
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      thread_id: message.threadId,
      reply_to_message_id: message.replyToId,
      external_message_id: message.id,
    };
    await this.opts.onMessage(jid, normalized);
  }
}

export function createTeamsChannel(
  opts: ChannelOpts,
  deps: TeamsChannelDependencies = {},
): TeamsChannel | null {
  const credentials =
    deps.credentials ?? readTeamsCredentials(opts.runtimeSecrets);
  if (!credentials) {
    logger.warn(
      'Teams: TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, and TEAMS_TENANT_ID are required',
    );
    return null;
  }
  const sdkClient =
    deps.sdkClient ?? createMicrosoftTeamsSdkClient(credentials);
  if (!sdkClient) {
    logger.warn(
      'Teams: Microsoft Teams SDK transport is not configured for this scaffold',
    );
    return null;
  }
  return new TeamsChannel(credentials, opts, sdkClient);
}

function readTeamsCredentials(
  secrets?: RuntimeSecretProvider,
): TeamsChannelCredentials | null {
  if (!secrets) return null;
  const clientId =
    secrets.getOptionalSecret({ env: 'TEAMS_CLIENT_ID' })?.trim() || '';
  const clientSecret =
    secrets.getOptionalSecret({ env: 'TEAMS_CLIENT_SECRET' })?.trim() || '';
  const tenantId =
    secrets.getOptionalSecret({ env: 'TEAMS_TENANT_ID' })?.trim() || '';
  if (!clientId || !clientSecret || !tenantId) return null;
  return { clientId, clientSecret, tenantId };
}

function createMicrosoftTeamsSdkClient(
  _credentials: TeamsChannelCredentials,
): TeamsSdkClient | null {
  return null;
}
