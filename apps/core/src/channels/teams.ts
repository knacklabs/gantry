import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import type {
  MessageSendOptions,
  NewMessage,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  decisionForMode,
  formatPermissionPromptText,
  formatPermissionReceiptText,
  normalizePermissionAction,
  permissionButtonLabel,
  permissionDecisionOptions,
} from './permission-interaction.js';

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

interface PendingTeamsPermissionPrompt {
  conversationId: string;
  sourceGroup: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  approvalContextJid?: string;
  request: PermissionApprovalRequest;
  threadId?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: PermissionApprovalDecision) => void;
  settled: boolean;
}

export interface TeamsChannelDependencies {
  sdkClient?: TeamsSdkClient;
  credentials?: TeamsChannelCredentials;
}

const TEAMS_PERMISSION_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export interface TeamsAdaptiveCardAction {
  type: 'Action.Execute';
  title: string;
  verb: string;
  data: {
    action: 'permission_decision';
    requestId: string;
    decision: string;
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
  const promptText = formatPermissionPromptText(
    request,
    TEAMS_PERMISSION_APPROVAL_TIMEOUT_MS,
  );
  const body: Array<Record<string, unknown>> = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: 'Permission request',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: promptText,
      wrap: true,
    },
  ];

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
    actions: permissionDecisionOptions(request).map((mode) => ({
      type: 'Action.Execute',
      title: permissionButtonLabel(mode, request),
      verb:
        mode === 'cancel'
          ? 'myclaw.permission.cancel'
          : 'myclaw.permission.allow',
      data: {
        action: 'permission_decision',
        requestId: request.requestId,
        decision: mode,
        sourceGroup: request.sourceGroup,
        targetJid: request.targetJid,
        threadId: request.threadId,
      },
    })),
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
  private readonly pendingPermissionPrompts = new Map<
    string,
    PendingTeamsPermissionPrompt
  >();

  constructor(
    private readonly credentials: TeamsChannelCredentials,
    private readonly opts: Pick<
      ChannelOpts,
      'onMessage' | 'onChatMetadata' | 'isControlApproverAllowed'
    >,
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
    for (const requestId of this.pendingPermissionPrompts.keys()) {
      await this.resolvePermissionPrompt(requestId, {
        approved: false,
        decidedBy: 'system',
        reason: 'Teams channel disconnected',
      });
    }
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
    if (await this.handlePermissionDecision(message, jid, sender, senderName)) {
      return;
    }

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
      provider: 'teams',
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

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> {
    if (!this.connected) {
      return { approved: false, reason: 'Teams channel is not connected' };
    }
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId) {
      return { approved: false, reason: 'Invalid Teams JID' };
    }
    if (!this.sdkClient.sendAdaptiveCard) {
      return {
        approved: false,
        reason: 'Teams SDK client cannot send Adaptive Cards',
      };
    }
    if (this.pendingPermissionPrompts.has(request.requestId)) {
      return {
        approved: false,
        reason: `Duplicate pending request: ${request.requestId}`,
      };
    }

    const approvalRequest = { ...request, targetJid: request.targetJid ?? jid };
    try {
      await this.sdkClient.sendAdaptiveCard({
        conversationId,
        card: buildTeamsApprovalAdaptiveCard(approvalRequest),
        ...(request.threadId ? { threadId: request.threadId } : {}),
      });
      return await new Promise<PermissionApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          void this.resolvePermissionPrompt(request.requestId, {
            approved: false,
            decidedBy: 'system',
            reason: 'timed out',
          });
        }, TEAMS_PERMISSION_APPROVAL_TIMEOUT_MS);
        this.pendingPermissionPrompts.set(request.requestId, {
          conversationId,
          sourceGroup: request.sourceGroup,
          decisionPolicy: request.decisionPolicy,
          approvalContextJid: request.approvalContextJid,
          request: approvalRequest,
          threadId: request.threadId,
          timer,
          resolve,
          settled: false,
        });
      });
    } catch (err) {
      logger.error(
        { jid, requestId: request.requestId, err },
        'Failed to send Teams permission prompt',
      );
      return {
        approved: false,
        reason: 'Failed to send approval prompt to Teams',
      };
    }
  }

  private async handlePermissionDecision(
    message: TeamsInboundMessage,
    jid: string,
    userId: string,
    userName: string,
  ): Promise<boolean> {
    const decisionPayload = readTeamsPermissionDecision(message.value);
    if (!decisionPayload) return false;
    const pending = this.pendingPermissionPrompts.get(
      decisionPayload.requestId,
    );
    if (!pending || pending.settled) return true;
    const conversationId = teamsConversationIdFromJid(jid);
    if (!conversationId || conversationId !== pending.conversationId) {
      logger.warn(
        { requestId: decisionPayload.requestId, jid },
        'Teams permission decision denied: wrong channel',
      );
      return true;
    }
    const authorized = await this.canDecidePermission(
      userId,
      pending.sourceGroup,
      pending.decisionPolicy,
      pending.approvalContextJid || jid,
    );
    if (!authorized) {
      logger.warn(
        { requestId: decisionPayload.requestId, userId, jid },
        'Teams permission decision denied: user is not a control approver',
      );
      return true;
    }
    const mode = normalizePermissionAction(decisionPayload.decision);
    if (!mode) return true;
    await this.resolvePermissionPrompt(
      decisionPayload.requestId,
      decisionForMode(pending.request, mode, userName),
    );
    return true;
  }

  private async canDecidePermission(
    userId: string,
    sourceGroup: string,
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'] | undefined,
    conversationJid: string,
  ): Promise<boolean> {
    if (decisionPolicy && decisionPolicy !== 'same_channel') return false;
    if (!this.opts.isControlApproverAllowed) return false;
    return this.opts.isControlApproverAllowed({
      providerId: 'teams',
      conversationJid,
      userId,
      sourceGroup,
      decisionPolicy,
    });
  }

  private async resolvePermissionPrompt(
    requestId: string,
    decision: PermissionApprovalDecision,
  ): Promise<void> {
    const pending = this.pendingPermissionPrompts.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pendingPermissionPrompts.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    try {
      await this.sdkClient.sendMessage({
        conversationId: pending.conversationId,
        text: formatPermissionReceiptText(requestId, pending.request, decision),
        ...(pending.threadId ? { threadId: pending.threadId } : {}),
      });
    } catch (err) {
      logger.debug(
        { requestId, err },
        'Failed to send Teams permission receipt',
      );
    }
  }
}

function readTeamsPermissionDecision(value: unknown): {
  requestId: string;
  decision: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as {
    action?: unknown;
    requestId?: unknown;
    decision?: unknown;
    data?: unknown;
  };
  const candidate =
    payload.action === 'permission_decision'
      ? payload
      : payload.data && typeof payload.data === 'object'
        ? (payload.data as typeof payload)
        : null;
  if (!candidate || candidate.action !== 'permission_decision') return null;
  if (typeof candidate.requestId !== 'string') return null;
  if (
    typeof candidate.decision !== 'string' ||
    !normalizePermissionAction(candidate.decision)
  ) {
    return null;
  }
  return {
    requestId: candidate.requestId,
    decision: candidate.decision,
  };
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
