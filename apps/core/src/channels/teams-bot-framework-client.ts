import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ActivityTypes,
  BotFrameworkAdapter,
  CardFactory,
  MessageFactory,
  TurnContext,
  type Activity,
  type ConversationReference,
  type ResourceResponse,
} from 'botbuilder';

import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  normalizeTeamsJid,
  type TeamsInboundMessage,
  type TeamsSdkAdaptiveCardMessage,
  type TeamsSdkClient,
  type TeamsSdkOutboundMessage,
  type TeamsSdkSendResult,
  type TeamsSdkStartInput,
} from './teams.js';
import {
  PostgresTeamsConversationReferenceStore,
  type TeamsConversationReferenceStore,
} from './teams-conversation-reference-store.js';

interface BotFrameworkNodeResponse {
  status(code: number): BotFrameworkNodeResponse;
  send(body: unknown): BotFrameworkNodeResponse;
  end(): void;
}

let activeClient: TeamsBotFrameworkSdkClient | null = null;

function setActiveTeamsBotFrameworkClient(
  client: TeamsBotFrameworkSdkClient | null,
): void {
  activeClient = client;
}

export function getActiveTeamsBotFrameworkClientForTest(): TeamsBotFrameworkSdkClient | null {
  return activeClient;
}

export async function handleTeamsBotFrameworkActivityRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!activeClient) return false;
  await activeClient.processActivity(req, res);
  return true;
}

export function createTeamsBotFrameworkSdkClient(): TeamsSdkClient {
  return new TeamsBotFrameworkSdkClient();
}

export class TeamsBotFrameworkSdkClient implements TeamsSdkClient {
  private adapter: BotFrameworkAdapter | null = null;
  private onMessage: TeamsSdkStartInput['onMessage'] | null = null;
  private store: TeamsConversationReferenceStore | null = null;

  async start(input: TeamsSdkStartInput): Promise<void> {
    this.adapter = new BotFrameworkAdapter({
      appId: input.credentials.botAppId || input.credentials.clientId,
      appPassword:
        input.credentials.botAppPassword || input.credentials.clientSecret,
      channelAuthTenant:
        input.credentials.botTenantId || input.credentials.tenantId,
    });
    this.adapter.onTurnError = async (_context, error) => {
      logger.error({ err: error }, 'Teams Bot Framework turn failed');
    };
    this.onMessage = input.onMessage;
    this.store =
      this.store ??
      new PostgresTeamsConversationReferenceStore(
        getRuntimeStorage().service.db,
      );
    setActiveTeamsBotFrameworkClient(this);
    logger.info(
      {
        endpoint: '/v1/providers/teams/activities',
        botAppId: input.credentials.botAppId || input.credentials.clientId,
      },
      'Teams Bot Framework transport started',
    );
  }

  async stop(): Promise<void> {
    if (activeClient === this) setActiveTeamsBotFrameworkClient(null);
    this.onMessage = null;
    this.adapter = null;
  }

  async processActivity(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const adapter = this.requireAdapter();
    await adapter.processActivity(
      req as Parameters<BotFrameworkAdapter['processActivity']>[0],
      createBotFrameworkResponse(res) as Parameters<
        BotFrameworkAdapter['processActivity']
      >[1],
      async (context) => this.handleTurn(context),
    );
  }

  async sendMessage(
    input: TeamsSdkOutboundMessage,
  ): Promise<TeamsSdkSendResult> {
    const response = await this.continueConversation(
      input.conversationId,
      (ctx) => ctx.sendActivity(MessageFactory.text(input.text)),
    );
    if (!response?.id) {
      throw new Error(
        `Teams send did not return a provider message id for conversation ${input.conversationId}.`,
      );
    }
    return { externalMessageId: response?.id };
  }

  async sendAdaptiveCard(
    input: TeamsSdkAdaptiveCardMessage,
  ): Promise<TeamsSdkSendResult> {
    const activity = MessageFactory.attachment(
      CardFactory.adaptiveCard(input.card),
    );
    const response = await this.continueConversation(
      input.conversationId,
      (ctx) => ctx.sendActivity(activity),
    );
    if (!response?.id) {
      throw new Error(
        `Teams adaptive card send did not return a provider message id for conversation ${input.conversationId}.`,
      );
    }
    return { externalMessageId: response?.id };
  }

  private async handleTurn(context: TurnContext): Promise<void> {
    const activity = context.activity;
    await this.rememberConversationReference(activity);

    if (activity.type === ActivityTypes.Message) {
      await this.deliverInboundActivity(activity);
      return;
    }

    if (activity.type === ActivityTypes.Invoke && activity.value) {
      void this.deliverInboundActivity(activity).catch((error) => {
        logger.error({ err: error }, 'Teams invoke activity handling failed');
      });
      await context.sendActivity({
        type: ActivityTypes.InvokeResponse,
        value: { status: 200, body: { ok: true } },
      });
    }
  }

  private async deliverInboundActivity(activity: Activity): Promise<void> {
    const onMessage = this.onMessage;
    if (!onMessage) return;
    const conversationId = activity.conversation?.id;
    if (!conversationId) return;
    const sender = getTeamsSender(activity);
    const text =
      activity.type === ActivityTypes.Message
        ? TurnContext.removeRecipientMention(activity) || activity.text || ''
        : activity.text || '';
    const inbound: TeamsInboundMessage = {
      conversationId,
      id: activity.id,
      text,
      name: activity.name,
      value: activity.value,
      from: activity.from
        ? { id: activity.from.id, name: activity.from.name }
        : undefined,
      senderId: sender.id,
      senderName: sender.name,
      timestamp:
        activity.timestamp instanceof Date
          ? activity.timestamp.toISOString()
          : activity.timestamp,
      threadId: activity.conversation?.id,
      replyToId: activity.replyToId,
      conversationName: activity.conversation?.name,
      conversationType: activity.conversation?.conversationType,
    };
    await onMessage(inbound);
  }

  private async rememberConversationReference(
    activity: Activity,
  ): Promise<void> {
    const store = this.requireStore();
    const conversationId = activity.conversation?.id;
    const serviceUrl = activity.serviceUrl;
    if (!conversationId || !serviceUrl) return;
    const conversationJid = normalizeTeamsJid(conversationId);
    if (!conversationJid) return;
    const reference = TurnContext.getConversationReference(activity);
    await store.save({
      conversationJid,
      conversationId,
      serviceUrl,
      tenantId: getTeamsTenantId(activity),
      botId: activity.recipient?.id,
      rawReferenceJson: JSON.stringify(reference),
    });
  }

  private async continueConversation(
    conversationId: string,
    send: (context: TurnContext) => Promise<ResourceResponse | undefined>,
  ): Promise<ResourceResponse | undefined> {
    const adapter = this.requireAdapter();
    const store = this.requireStore();
    const conversationJid = normalizeTeamsJid(conversationId);
    if (!conversationJid) {
      throw new Error(`Invalid Teams conversation ID: ${conversationId}`);
    }
    const stored = await store.get(conversationJid);
    if (!stored) {
      throw new Error(
        `No Teams conversation reference found for ${conversationJid}; send a message to the bot in that Teams conversation first.`,
      );
    }
    const reference = JSON.parse(
      stored.rawReferenceJson,
    ) as Partial<ConversationReference>;
    let response: ResourceResponse | undefined;
    await adapter.continueConversation(reference, async (context) => {
      response = await send(context);
    });
    return response;
  }

  private requireAdapter(): BotFrameworkAdapter {
    if (!this.adapter) {
      throw new Error('Teams Bot Framework transport is not started');
    }
    return this.adapter;
  }

  private requireStore(): TeamsConversationReferenceStore {
    if (!this.store) {
      this.store = new PostgresTeamsConversationReferenceStore(
        getRuntimeStorage().service.db,
      );
    }
    return this.store;
  }
}

function createBotFrameworkResponse(
  res: ServerResponse,
): BotFrameworkNodeResponse {
  let pendingBody: unknown;
  return {
    status(code: number): BotFrameworkNodeResponse {
      res.statusCode = code;
      return this;
    },
    send(body: unknown): BotFrameworkNodeResponse {
      pendingBody = body;
      return this;
    },
    end(): void {
      if (res.writableEnded) return;
      if (pendingBody === undefined) {
        res.end();
        return;
      }
      if (
        Buffer.isBuffer(pendingBody) ||
        typeof pendingBody === 'string' ||
        pendingBody instanceof Uint8Array
      ) {
        res.end(pendingBody);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(pendingBody));
    },
  };
}

function getTeamsSender(activity: Activity): { id: string; name: string } {
  const from = activity.from as
    | (Activity['from'] & {
        aadObjectId?: unknown;
        userPrincipalName?: unknown;
      })
    | undefined;
  const aadObjectId =
    typeof from?.aadObjectId === 'string' ? from.aadObjectId : '';
  const userPrincipalName =
    typeof from?.userPrincipalName === 'string' ? from.userPrincipalName : '';
  const id = aadObjectId || from?.id || userPrincipalName || 'unknown';
  return { id, name: from?.name || userPrincipalName || id };
}

function getTeamsTenantId(activity: Activity): string | undefined {
  const tenant = activity.channelData as { tenant?: { id?: unknown } };
  return typeof tenant?.tenant?.id === 'string' ? tenant.tenant.id : undefined;
}

export const _testTeamsBotFrameworkClient = {
  createBotFrameworkResponse,
  getTeamsSender,
  getTeamsTenantId,
};
