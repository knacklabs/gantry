import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ActivityTypes,
  BotFrameworkAdapter,
  TurnContext,
  type Activity,
  type ConversationReference,
  type ResourceResponse,
} from 'botbuilder';
import type {
  BotFrameworkAdapterLike,
  GantryBotFrameworkTeamsTransportConfig,
  GantryDispatchResult,
  GantryRuntimeStorage,
  GantryTeamsIncomingActivity,
  GantryTeamsStoredConversationReference,
  GantryTeamsTransport,
} from './types.js';
import { asRecord, readString, requireNonEmpty } from '../../shared/helpers.js';

export function createBotFrameworkTeamsTransport(
  config: GantryBotFrameworkTeamsTransportConfig,
): GantryTeamsTransport {
  const adapter =
    config.adapter ??
    new BotFrameworkAdapter({
      appId: requireNonEmpty(config.botAppId, 'botAppId'),
      appPassword: requireNonEmpty(config.botAppPassword, 'botAppPassword'),
      channelAuthTenant: config.botTenantId?.trim() || undefined,
    });

  async function sendToConversation(
    conversationId: string,
    send: (context: TurnContext) => Promise<ResourceResponse | undefined>,
    referenceConversationId = conversationId,
  ): Promise<GantryDispatchResult> {
    const reference = await readConversationReference(
      config.storage,
      referenceConversationId,
    );
    let response: ResourceResponse | undefined;
    await adapter.continueConversation(
      parseStoredReference(reference, conversationId),
      async (context) => {
        response = await send(context);
      },
    );
    return {
      accepted: true,
      statusCode: 202,
      body: teamsDeliveryReceiptBody(response, conversationId),
    };
  }

  return {
    sendCard: async (input) =>
      await sendToConversation(input.conversationId, async (context) => {
        return await context.sendActivity({
          type: ActivityTypes.Message,
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: input.card,
            },
          ],
        });
      }),
    sendDm: async (input) => {
      const reference =
        await config.storage.getTeamsPersonalConversationReference?.({
          teamsUserId: input.teamsUserId,
          teamsTenantId: input.teamsTenantId,
        });
      if (!reference?.rawReferenceJson) {
        return {
          accepted: false,
          statusCode: 409,
          body: { code: 'teams_personal_conversation_reference_missing' },
        };
      }
      let response: ResourceResponse | undefined;
      const storedReference = parseStoredReference(
        reference,
        reference.conversationId,
      );
      const sendActivity = async (context: TurnContext) => {
        response = await context.sendActivity(
          input.card
            ? {
                type: ActivityTypes.Message,
                text: input.text ?? undefined,
                attachments: [
                  {
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    content: input.card,
                  },
                ],
              }
            : { type: ActivityTypes.Message, text: input.text ?? '' },
        );
      };
      if (isPersonalTeamsConversationReference(storedReference)) {
        await adapter.continueConversation(storedReference, sendActivity);
      } else {
        const createConversation = adapter.createConversation?.bind(adapter);
        if (!createConversation) {
          return {
            accepted: false,
            statusCode: 409,
            body: { code: 'teams_personal_conversation_reference_missing' },
          };
        }
        await createConversation(
          storedReference,
          {
            isGroup: false,
            members: storedReference.user ? [storedReference.user] : undefined,
          },
          sendActivity,
        );
      }
      return {
        accepted: true,
        statusCode: 202,
        body: teamsDeliveryReceiptBody(response, reference.conversationId),
      };
    },
    sendThreadReply: async (input) =>
      await sendToConversation(
        teamsThreadConversationId(input.conversationId, input.replyToId),
        async (context) =>
          await context.sendActivity({
            type: ActivityTypes.Message,
            text: input.text,
            replyToId: input.replyToId,
          }),
        teamsBaseConversationIdFromThreadConversationId(input.conversationId),
      ),
    handleIncomingActivity: (input) =>
      parseTeamsIncomingActivity(input.activity),
    handleHttpActivity: async (input) => {
      await adapter.processActivity(
        input.req,
        createBotFrameworkResponse(input.res),
        async (context) => {
          const activity = parseBotFrameworkActivity(context.activity);
          await rememberTeamsConversationReference(
            config.storage,
            context.activity,
          );
          await input.onActivity(activity);
          if (context.activity.type === ActivityTypes.Invoke) {
            await context.sendActivity({
              type: ActivityTypes.InvokeResponse,
              value: {
                status: 200,
                body: 'Action received.',
              },
            });
          }
        },
      );
    },
  };
}

function teamsDeliveryReceiptBody(
  response: ResourceResponse | undefined,
  conversationId: string,
): Record<string, unknown> {
  const activityId = response?.id ?? null;
  return {
    ...(response ? { resourceResponse: response } : {}),
    id: activityId,
    messageId: activityId,
    activityId,
    conversationId,
  };
}

export function parseTeamsIncomingActivity(
  activity: Record<string, unknown>,
): GantryTeamsIncomingActivity {
  const conversation = asRecord(activity.conversation);
  const from = asRecord(activity.from);
  const channelData = asRecord(activity.channelData);
  const tenant = asRecord(channelData?.tenant);
  const conversationId = readString(conversation, 'id') ?? '';
  const messageId =
    readString(activity, 'id') ?? `teams:${conversationId}:${Date.now()}`;
  const type = readString(activity, 'type');
  return {
    provider: 'teams',
    type:
      type === 'message' ? 'message' : type === 'invoke' ? 'invoke' : 'unknown',
    messageId,
    conversationId,
    replyToId: readString(activity, 'replyToId'),
    text: readString(activity, 'text'),
    value: activity.value,
    teamsTenantId:
      readString(tenant, 'id') ?? readString(channelData, 'tenantId'),
    teamsUserId: readString(from, 'aadObjectId') ?? readString(from, 'id'),
    teamsUserDisplayName: readString(from, 'name'),
    raw: activity,
  };
}

function parseBotFrameworkActivity(
  activity: Activity,
): GantryTeamsIncomingActivity {
  return parseTeamsIncomingActivity(
    activity as unknown as Record<string, unknown>,
  );
}

async function rememberTeamsConversationReference(
  storage: GantryRuntimeStorage,
  activity: Activity,
): Promise<void> {
  if (!storage.saveTeamsConversationReference) return;
  const conversationId = activity.conversation?.id;
  if (!conversationId || !activity.serviceUrl) return;
  const canonicalConversationId =
    readTeamsChannelConversationId(activity) ??
    canonicalTeamsConversationId(conversationId);
  const reference = TurnContext.getConversationReference(activity);
  const from = activity.from as
    | { id?: string; aadObjectId?: string; name?: string }
    | undefined;
  const channelData = asRecord(activity.channelData);
  const tenant = asRecord(channelData?.tenant);
  await storage.saveTeamsConversationReference({
    exists: true,
    conversationId: canonicalConversationId,
    conversationJid: normalizeTeamsJid(canonicalConversationId),
    serviceUrl: activity.serviceUrl,
    tenantId: readString(tenant, 'id') ?? readString(channelData, 'tenantId'),
    botId: activity.recipient?.id,
    teamsUserId: from?.aadObjectId ?? from?.id ?? null,
    rawReferenceJson: JSON.stringify(reference),
    updatedAt: new Date().toISOString(),
  });
}

async function readConversationReference(
  storage: GantryRuntimeStorage,
  conversationId: string,
): Promise<GantryTeamsStoredConversationReference> {
  const reference =
    await storage.getTeamsConversationReference?.(conversationId);
  if (!reference?.rawReferenceJson) {
    throw new Error(
      `No Teams conversation reference found for ${conversationId}.`,
    );
  }
  return reference;
}

function parseStoredReference(
  reference: GantryTeamsStoredConversationReference,
  conversationId: string,
): Partial<ConversationReference> {
  const parsed = JSON.parse(
    reference.rawReferenceJson ?? '{}',
  ) as Partial<ConversationReference>;
  if (parsed.conversation) {
    parsed.conversation.id = conversationId;
  }
  return parsed;
}

function teamsBaseConversationIdFromThreadConversationId(
  conversationId: string,
): string {
  return canonicalTeamsConversationId(conversationId);
}

function teamsThreadConversationId(
  conversationId: string,
  replyToId: string,
): string {
  const canonical =
    teamsBaseConversationIdFromThreadConversationId(conversationId);
  return `${canonical};messageid=${replyToId.trim()}`;
}

function normalizeTeamsJid(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('teams:') ? trimmed : `teams:${trimmed}`;
}

function canonicalTeamsConversationId(conversationId: string): string {
  const trimmed = conversationId.trim();
  const messageIdIndex = trimmed.toLowerCase().indexOf(';messageid=');
  if (messageIdIndex < 0) return trimmed;
  return trimmed.slice(0, messageIdIndex).trim() || trimmed;
}

function readTeamsChannelConversationId(activity: Activity): string | null {
  const channelData = asRecord(activity.channelData);
  const channel = asRecord(channelData?.channel);
  return readString(channelData, 'teamsChannelId') ?? readString(channel, 'id');
}

function isPersonalTeamsConversationReference(
  reference: Partial<ConversationReference>,
): boolean {
  const conversation = reference.conversation as
    | {
        readonly conversationType?: string | null;
        readonly isGroup?: boolean | null;
      }
    | undefined;
  return (
    conversation?.conversationType === 'personal' ||
    conversation?.isGroup === false
  );
}

function createBotFrameworkResponse(res: ServerResponse): {
  status(code: number): { send(body: unknown): { end(): void }; end(): void };
  send(body: unknown): { end(): void };
  end(): void;
} {
  let pendingBody: unknown;
  const response = {
    status(code: number) {
      res.statusCode = code;
      return response;
    },
    send(body: unknown) {
      pendingBody = body;
      return response;
    },
    end() {
      if (res.writableEnded) return;
      if (pendingBody === undefined) {
        res.end();
      } else if (
        typeof pendingBody === 'string' ||
        Buffer.isBuffer(pendingBody)
      ) {
        res.end(pendingBody);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(pendingBody));
      }
    },
  };
  return response;
}
