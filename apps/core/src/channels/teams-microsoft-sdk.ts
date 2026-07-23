import type { IncomingMessage, ServerResponse } from 'node:http';

import { Activity, ActivityTypes } from '@microsoft/agents-activity';
import {
  authorizeJWT,
  CloudAdapter,
  type AuthConfiguration,
  type TurnContext,
} from '@microsoft/agents-hosting';

import { logger } from '../infrastructure/logging/logger.js';
import { TEAMS_ADAPTIVE_CARD_CONTENT_TYPE } from './teams-cards.js';
import type {
  TeamsChannelCredentials,
  TeamsSdkAdaptiveCardMessage,
  TeamsSdkClient,
  TeamsSdkOutboundMessage,
  TeamsSdkSendResult,
  TeamsSdkStartInput,
} from './teams-types.js';

type ConversationReference = ReturnType<Activity['getConversationReference']>;
type MicrosoftAdapter = Pick<CloudAdapter, 'process' | 'continueConversation'>;
type MicrosoftAuthorize = ReturnType<typeof authorizeJWT>;

export interface MicrosoftTeamsSdkClientDeps {
  adapter?: MicrosoftAdapter;
  authorize?: MicrosoftAuthorize;
}

const MICROSOFT_TEAMS_CONNECTION = 'serviceConnection';
const ADAPTIVE_CARD_ACTION_INVOKE_NAME = 'adaptiveCard/action';
const ACTION_EXECUTE_TYPE = 'Action.Execute';
const ADAPTIVE_CARD_MESSAGE_RESPONSE_TYPE =
  'application/vnd.microsoft.activity.message';
const ADAPTIVE_CARD_ERROR_RESPONSE_TYPE = 'application/vnd.microsoft.error';
const TEAMS_CONVERSATION_REFERENCE_CACHE_MAX_ENTRIES = 5_000;

export function buildMicrosoftTeamsAuthConfiguration(
  credentials: TeamsChannelCredentials,
): AuthConfiguration {
  const connection: AuthConfiguration = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    tenantId: credentials.tenantId,
  };
  return {
    ...connection,
    connectionName: MICROSOFT_TEAMS_CONNECTION,
    connections: new Map([[MICROSOFT_TEAMS_CONNECTION, connection]]),
    connectionsMap: [
      { serviceUrl: '*', connection: MICROSOFT_TEAMS_CONNECTION },
    ],
  };
}

/**
 * Thin Microsoft 365 Agents SDK transport. Gantry's channel adapter remains
 * responsible for routing, persistence, authorization callbacks, and memory.
 */
export class MicrosoftTeamsSdkClient implements TeamsSdkClient {
  private readonly adapter: MicrosoftAdapter;
  private readonly authorize: MicrosoftAuthorize;
  private readonly references = new Map<string, ConversationReference>();
  private onMessage?: TeamsSdkStartInput['onMessage'];

  constructor(
    private readonly credentials: TeamsChannelCredentials,
    deps: MicrosoftTeamsSdkClientDeps = {},
  ) {
    const auth = buildMicrosoftTeamsAuthConfiguration(credentials);
    this.adapter =
      deps.adapter ??
      new CloudAdapter(auth, undefined, undefined, {
        validateServiceUrl: true,
      });
    this.authorize = deps.authorize ?? authorizeJWT(auth);
  }

  async start(input: TeamsSdkStartInput): Promise<void> {
    this.onMessage = input.onMessage;
  }

  async stop(): Promise<void> {
    this.onMessage = undefined;
    this.references.clear();
  }

  getAuthenticatedConversationRegistrationCount(): number {
    return this.references.size;
  }

  async handleHttpIngress(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!this.onMessage) {
      response.statusCode = 503;
      response.end('Microsoft Teams transport is not started.');
      return;
    }
    const sdkRequest = Object.assign(request, { body });
    const sdkResponse = microsoftResponse(response);
    const authorized = await authorizeRequest(
      this.authorize,
      sdkRequest,
      sdkResponse,
    );
    if (!authorized || response.writableEnded) return;
    await this.adapter.process(
      sdkRequest as never,
      sdkResponse as never,
      async (context) => this.receive(context),
    );
  }

  sendMessage(input: TeamsSdkOutboundMessage): Promise<TeamsSdkSendResult> {
    return this.send(input, { type: ActivityTypes.Message, text: input.text });
  }

  sendAdaptiveCard(
    input: TeamsSdkAdaptiveCardMessage,
  ): Promise<TeamsSdkSendResult> {
    return this.send(input, {
      type: ActivityTypes.Message,
      attachments: [
        {
          contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
          content: input.card,
        },
      ],
    });
  }

  private async receive(context: TurnContext): Promise<void> {
    const activity = context.activity;
    const conversationId = activity.conversation?.id?.trim();
    if (!conversationId) return;
    const reference = activity.getConversationReference({
      forceBaseChannel: true,
    });
    const activityRecord = jsonRecord(activity);
    const channelData = record(activityRecord.channelData);
    const tenant = record(channelData.tenant);
    const channel = record(channelData.channel);
    const quotedReply = teamsQuotedReply(activityRecord);
    const replyToId = quotedReply.replyToId ?? activity.replyToId;
    const actionInvoke = adaptiveCardActionInvoke(activity);
    this.rememberConversationReference(conversationId, reference);
    if (actionInvoke?.valid === false) {
      await sendAdaptiveCardInvokeResponse(context, {
        statusCode: 400,
        type: ADAPTIVE_CARD_ERROR_RESPONSE_TYPE,
        value: {
          code: 'BadRequest',
          message: 'Invalid Adaptive Card action.',
        },
      });
      return;
    }
    const actionValue = actionInvoke?.data ?? activity.value;
    try {
      await this.onMessage?.({
        conversationId,
        id: activity.id,
        text: quotedReply.text ?? activity.text,
        name: activity.name,
        value: actionValue,
        from: activity.from
          ? { id: activity.from.id, name: activity.from.name }
          : undefined,
        senderId: activity.from?.aadObjectId ?? activity.from?.id,
        senderName: activity.from?.name,
        timestamp:
          activity.timestamp instanceof Date
            ? activity.timestamp.toISOString()
            : activity.timestamp,
        threadId:
          teamsThreadIdFromConversationId(conversationId) ??
          replyToId ??
          activity.id,
        replyToId,
        conversationName: activity.conversation?.name,
        conversationType: activity.conversation?.conversationType,
        attachments: activity.attachments?.map((attachment) => ({
          id:
            typeof attachment.contentUrl === 'string'
              ? attachment.contentUrl
              : undefined,
          contentType: attachment.contentType,
        })),
        conversationReference: jsonRecord(reference),
        providerData: {
          activityType: activity.type,
          recipientId: activity.recipient?.id,
          conversationExternalRef: {
            microsoftConversationReference: jsonRecord(reference),
          },
          tenantId: activity.conversation?.tenantId ?? stringValue(tenant.id),
          channelId:
            stringValue(channel.id) ?? stringValue(channelData.channelId),
          mentions: Array.isArray(activityRecord.entities)
            ? activityRecord.entities.flatMap((value) => {
                const entity = record(value);
                if (stringValue(entity.type)?.toLowerCase() !== 'mention') {
                  return [];
                }
                const mentioned = record(entity.mentioned);
                return [
                  {
                    id: stringValue(mentioned.id),
                    name: stringValue(mentioned.name),
                    text: stringValue(entity.text),
                  },
                ];
              })
            : [],
          hasUnsupportedAttachments: Boolean(
            activity.attachments?.some(
              (attachment) =>
                !/^text\/html(?:;|$)/iu.test(attachment.contentType ?? ''),
            ),
          ),
          ...(actionValue !== undefined ? { actionValue } : {}),
          ...(actionInvoke
            ? {
                actionType: ACTION_EXECUTE_TYPE,
                actionVerb: actionInvoke.verb,
              }
            : {}),
        },
      });
    } catch (error) {
      if (!actionInvoke) throw error;
      logger.warn(
        { err: error, conversationId, activityId: activity.id },
        'Failed to process Microsoft Teams Adaptive Card action',
      );
      await sendAdaptiveCardInvokeResponse(context, {
        statusCode: 500,
        type: ADAPTIVE_CARD_ERROR_RESPONSE_TYPE,
        value: {
          code: 'InternalServerError',
          message: 'Unable to process this action. Please try again.',
        },
      });
      return;
    }
    if (actionInvoke) {
      await sendAdaptiveCardInvokeResponse(context, {
        statusCode: 200,
        type: ADAPTIVE_CARD_MESSAGE_RESPONSE_TYPE,
        value: 'Action received.',
      });
    }
  }

  private async send(
    input: TeamsSdkOutboundMessage | TeamsSdkAdaptiveCardMessage,
    activityInput: Record<string, unknown>,
  ): Promise<TeamsSdkSendResult> {
    const persisted = input.conversationReference
      ? conversationReference(input.conversationReference)
      : undefined;
    if (persisted) {
      this.rememberConversationReference(input.conversationId, persisted);
    }
    const reference = persisted ?? this.references.get(input.conversationId);
    if (!reference) {
      throw new Error(
        `No Microsoft Teams conversation reference is registered for ${input.conversationId}.`,
      );
    }
    let externalMessageId: string | undefined;
    await this.adapter.continueConversation(
      this.credentials.clientId,
      teamsOutboundConversationReference(reference, input.threadId),
      async (context) => {
        const activity = Activity.fromObject({
          ...activityInput,
          ...(input.threadId ? { replyToId: input.threadId } : {}),
        });
        const sent = await context.sendActivity(activity);
        externalMessageId = sent?.id;
      },
    );
    return externalMessageId ? { externalMessageId } : {};
  }

  private rememberConversationReference(
    conversationId: string,
    reference: ConversationReference,
  ): void {
    this.references.delete(conversationId);
    this.references.set(conversationId, reference);
    while (
      this.references.size > TEAMS_CONVERSATION_REFERENCE_CACHE_MAX_ENTRIES
    ) {
      const oldest = this.references.keys().next().value;
      if (!oldest) break;
      this.references.delete(oldest);
    }
  }
}

function teamsOutboundConversationReference(
  reference: ConversationReference,
  threadId?: string,
): ConversationReference {
  if (threadId) return reference;
  const copy = jsonRecord(reference);
  const conversation = record(copy.conversation);
  const conversationId = stringValue(conversation.id);
  if (!conversationId) return reference;
  const markerIndex = conversationId.lastIndexOf(';messageid=');
  if (markerIndex < 0) return reference;
  copy.conversation = {
    ...conversation,
    id: conversationId.slice(0, markerIndex),
  };
  delete copy.activityId;
  return copy as unknown as ConversationReference;
}

export function createMicrosoftTeamsSdkClient(
  credentials: TeamsChannelCredentials,
): TeamsSdkClient {
  return new MicrosoftTeamsSdkClient(credentials);
}

function conversationReference(
  value: Record<string, unknown>,
): ConversationReference | undefined {
  const conversation = value.conversation;
  const channelId = value.channelId;
  if (
    !conversation ||
    typeof conversation !== 'object' ||
    typeof (conversation as { id?: unknown }).id !== 'string' ||
    typeof channelId !== 'string'
  ) {
    return undefined;
  }
  return value as unknown as ConversationReference;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function teamsQuotedReply(activity: Record<string, unknown>): {
  replyToId?: string;
  text?: string;
} {
  const text = stringValue(activity.text);
  const entityReplyToId = Array.isArray(activity.entities)
    ? activity.entities
        .map((entity) =>
          stringValue(record(record(entity).quotedReply).messageId),
        )
        .find(Boolean)
    : undefined;
  const markerReplyToId = text?.match(
    /<quoted\s+messageId=(["'])([^"']+)\1\s*\/>/iu,
  )?.[2];
  return {
    replyToId:
      entityReplyToId ??
      stringValue(markerReplyToId) ??
      stringValue(activity.replyToId),
    text: text
      ?.replace(/^\s*<quoted\s+messageId=(["'])([^"']+)\1\s*\/>\s*/iu, '')
      .trim(),
  };
}

function teamsThreadIdFromConversationId(
  conversationId: string,
): string | undefined {
  const marker = ';messageid=';
  const markerIndex = conversationId.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  return stringValue(conversationId.slice(markerIndex + marker.length));
}

function adaptiveCardActionInvoke(
  activity: Activity,
):
  | { valid: true; data: Record<string, unknown>; verb: string }
  | { valid: false }
  | undefined {
  if (
    activity.type !== ActivityTypes.Invoke ||
    activity.name !== ADAPTIVE_CARD_ACTION_INVOKE_NAME
  ) {
    return undefined;
  }
  const action = record(record(activity.value).action);
  const data = action.data;
  const verb = stringValue(action.verb);
  if (
    action.type !== ACTION_EXECUTE_TYPE ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !verb
  ) {
    return { valid: false };
  }
  return { valid: true, data: { ...(data as Record<string, unknown>) }, verb };
}

async function sendAdaptiveCardInvokeResponse(
  context: TurnContext,
  body: {
    statusCode: number;
    type: string;
    value: unknown;
  },
): Promise<void> {
  await context.sendActivity(
    Activity.fromObject({
      type: ActivityTypes.InvokeResponse,
      value: { status: 200, body },
    }),
  );
}

type MicrosoftResponse = ServerResponse & {
  status(code: number): MicrosoftResponse;
  send(body: unknown): MicrosoftResponse;
};

function microsoftResponse(response: ServerResponse): MicrosoftResponse {
  const target = response as MicrosoftResponse;
  target.status = (code) => {
    response.statusCode = code;
    return target;
  };
  target.send = (body) => {
    if (response.writableEnded) return target;
    if (body !== undefined) {
      if (typeof body === 'object' && !Buffer.isBuffer(body)) {
        if (!response.headersSent) {
          response.setHeader('content-type', 'application/json');
        }
        response.write(JSON.stringify(body));
      } else {
        response.write(body as string | Uint8Array);
      }
    }
    response.end();
    return target;
  };
  return target;
}

async function authorizeRequest(
  authorize: ReturnType<typeof authorizeJWT>,
  request: IncomingMessage & { body: Record<string, unknown> },
  response: MicrosoftResponse,
): Promise<boolean> {
  let authorized = false;
  await authorize(request as never, response as never, () => {
    authorized = true;
  });
  return authorized;
}
