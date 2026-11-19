import type { IncomingMessage, ServerResponse } from 'node:http';

import { App, type HttpRouteHandler } from '@microsoft/teams.apps';
import {
  PUBLIC,
  type IMessageActivityInput,
  type ITypingActivityInput,
} from '@microsoft/teams.api';
import { z } from 'zod';

import { logger } from '../../infrastructure/logging/logger.js';
import type { TeamsConversationRouteStore } from './conversation-route-store.js';
import type {
  TeamsChannelCredentials,
  TeamsInboundMessage,
  TeamsSdkClient,
  TeamsSdkStartInput,
  TeamsSdkSendResult,
  TeamsSdkAdaptiveCardUpdate,
} from './types.js';

const MAX_ACTIVITY_BYTES = 256 * 1024;
const inboundClients = new Map<string, MicrosoftTeamsSdkClient>();
const identifier = z.string().trim().min(1);
const activitySchema = z.object({
  type: identifier,
  id: identifier.optional(),
  channelId: z.literal('msteams'),
  serviceUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }),
  conversation: z.object({
    id: identifier,
    name: z.string().optional(),
    conversationType: z.string().optional(),
    tenantId: z.string().optional(),
  }),
  recipient: z.object({ id: identifier }),
  from: z
    .object({
      id: identifier,
      aadObjectId: z.uuid().optional(),
      name: z.string().optional(),
    })
    .optional(),
  entities: z
    .array(
      z
        .object({
          type: z.string(),
          mentioned: z.object({ id: z.string() }).optional(),
          text: z.string().optional(),
        })
        .passthrough(),
    )
    .optional(),
  channelData: z
    .object({ tenant: z.object({ id: identifier }).optional() })
    .passthrough()
    .optional(),
  text: z.string().optional(),
  name: z.string().optional(),
  value: z.unknown().optional(),
  replyToId: z.string().optional(),
  timestamp: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .optional(),
});

export interface TeamsActivityRequest {
  providerAccountId: string;
  request: IncomingMessage;
  response: ServerResponse;
}

/** Called with untouched Node streams; registration is owned by each live client. */
export async function processTeamsActivity(
  input: TeamsActivityRequest,
): Promise<void> {
  const client = inboundClients.get(input.providerAccountId);
  if (!client) {
    respond(input.response, 503, {
      error:
        'Teams inbound is unavailable. Send this endpoint to the live worker and enable this account.',
    });
    return;
  }
  await client.receive(input.request, input.response);
}

function respond(
  response: ServerResponse,
  status: number,
  body?: unknown,
): void {
  response.statusCode = status;
  if (body !== undefined) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  } else response.end();
}

async function readActivity(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_ACTIVITY_BYTES) throw new Error('Activity too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function cardValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('action' in value)) return value;
  const action = value.action;
  return action && typeof action === 'object' && 'data' in action
    ? action.data
    : value;
}

class MicrosoftTeamsSdkClient implements TeamsSdkClient {
  private readonly app: App;
  private httpHandler?: HttpRouteHandler;
  private onMessage?: TeamsSdkStartInput['onMessage'];
  private started = false;
  private readonly accountIds: string[];

  constructor(
    private readonly credentials: TeamsChannelCredentials,
    private readonly options: {
      providerAccountId: string;
      inboundProviderAccountIds?: string[];
      routeStore: TeamsConversationRouteStore;
    },
  ) {
    this.accountIds = [
      ...new Set([
        options.providerAccountId,
        ...(options.inboundProviderAccountIds ?? []),
      ]),
    ];
    // SDK logs include entire activities and credential-bearing HTTP errors.
    // Gantry logs only fixed, redacted outcomes at this boundary.
    const sdkLogger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      trace() {},
      log() {},
      child() {
        return this;
      },
    };
    this.app = new App({
      ...credentials,
      cloud: PUBLIC,
      dangerouslyAllowUnauthenticatedRequests: false,
      logger: sdkLogger,
      httpServerAdapter: {
        registerRoute: (_method, _path, handler) => {
          this.httpHandler = handler;
        },
      },
    });
    // The SDK owns Microsoft authentication. Gantry owns durable storage,
    // agent execution and authorization, without SDK turn state.
    this.app.server.onRequest = ({ body }) =>
      this.handleAuthenticatedActivity(body);
  }

  private get routeStore(): TeamsConversationRouteStore {
    return this.options.routeStore;
  }

  async start(input: TeamsSdkStartInput): Promise<void> {
    if (this.started) return;
    await this.app.initialize();
    if (input.inbound !== false) {
      if (this.accountIds.some((id) => inboundClients.has(id))) {
        throw new Error(
          'Teams inbound is already running for this account. Stop the other client before reconnecting.',
        );
      }
      this.onMessage = input.onMessage;
      for (const id of this.accountIds) inboundClients.set(id, this);
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const id of this.accountIds)
      if (inboundClients.get(id) === this) inboundClients.delete(id);
    this.onMessage = undefined;
    this.started = false;
  }

  async receive(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const authorization = request.headers.authorization;
    if (
      !authorization ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
        authorization,
      )
    ) {
      respond(response, 401, { error: 'Teams authentication failed.' });
      return;
    }
    let raw: unknown;
    try {
      raw = await readActivity(request);
    } catch {
      respond(response, 400, { error: 'Invalid Teams activity.' });
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      respond(response, 400, { error: 'Invalid Teams activity.' });
      return;
    }
    // Connector tokens bind serviceUrl. Agent365 Entra tokens do not and
    // belong to a different ingress, outside this bot transport's scope.
    let issuer: unknown;
    try {
      issuer = JSON.parse(
        Buffer.from(authorization.split('.')[1]!, 'base64url').toString('utf8'),
      ).iss;
    } catch {
      /* The SDK verifies every accepted token below. */
    }
    if (issuer !== PUBLIC.tokenIssuer) {
      respond(response, 401, { error: 'Teams authentication failed.' });
      return;
    }
    // Never project the SDK's preauthenticated token field from HTTP input.
    const result = await this.httpHandler!({
      body: raw,
      headers: { authorization },
    });
    if (result.status === 401) {
      logger.debug(
        { providerId: 'teams', outcome: 'unauthenticated' },
        'Teams activity refused',
      );
      respond(response, 401, { error: 'Teams authentication failed.' });
    } else respond(response, result.status, result.body);
  }

  private async handleAuthenticatedActivity(raw: unknown) {
    const parsed = activitySchema.safeParse(raw);
    if (!parsed.success) {
      return { status: 400, body: { error: 'Invalid Teams activity.' } };
    }
    const activity = parsed.data;
    const tenantId =
      activity.channelData?.tenant?.id ?? activity.conversation.tenantId;
    if (
      tenantId !== this.credentials.tenantId ||
      (activity.conversation.tenantId &&
        activity.conversation.tenantId !== tenantId)
    ) {
      return {
        status: 403,
        body: { error: 'This Teams tenant is not allowed.' },
      };
    }
    const [conversationId, suffixRoot] =
      activity.conversation.id.split(';messageid=');
    if (
      !conversationId ||
      ((activity.type === 'message' || activity.type === 'invoke') &&
        (!activity.id || !activity.from))
    ) {
      return { status: 400, body: { error: 'Invalid Teams activity.' } };
    }
    const isInvoke = activity.type === 'invoke';
    try {
      await this.routeStore.upsertForProviderAccounts({
        providerAccountIds: this.accountIds,
        route: {
          conversationJid: `teams:${conversationId}`,
          serviceUrl: activity.serviceUrl,
          tenantId,
          botId: activity.recipient.id,
          channelId: activity.channelId,
          conversationType: activity.conversation.conversationType ?? null,
        },
      });
      if (activity.type === 'message' || isInvoke) {
        const threadId =
          suffixRoot ||
          activity.replyToId ||
          (activity.conversation.conversationType === 'channel'
            ? activity.id
            : undefined);
        const botMentions = (activity.entities ?? []).filter(
          (entity) =>
            entity.type === 'mention' &&
            entity.mentioned?.id === activity.recipient.id,
        );
        let text = activity.text;
        for (const mention of botMentions) {
          if (mention.text) text = text?.split(mention.text).join('');
        }
        const message: TeamsInboundMessage = {
          conversationId,
          id: activity.id,
          text: text?.trim(),
          mentionsBot: botMentions.length > 0,
          // Graph membership, sender policies and configured approvers use
          // Entra IDs. A bot-scoped ID alone cannot match a GUID allowlist.
          senderId: activity.from?.aadObjectId ?? activity.from?.id,
          senderName: activity.from?.name,
          timestamp: activity.timestamp,
          threadId,
          replyToId: activity.replyToId,
          conversationName: activity.conversation.name,
          conversationType: activity.conversation.conversationType,
          name: activity.name,
          value: isInvoke ? cardValue(activity.value) : activity.value,
        };
        // A provider retry is safer than acknowledging a failed durable save.
        await this.onMessage!(message);
      }
      if (isInvoke)
        return {
          status: 200,
          body: {
            statusCode: 200,
            type: 'application/vnd.microsoft.activity.message',
            value: 'Action received.',
          },
        };
      return { status: 200 };
    } catch {
      logger.warn(
        {
          providerId: 'teams',
          activityType: activity.type,
          outcome: 'handling_failed',
        },
        'Teams activity could not be handled',
      );
      // Teams reads handled invoke failures from the envelope's statusCode.
      return {
        status: isInvoke ? 200 : 500,
        body: isInvoke
          ? {
              statusCode: 500,
              type: 'application/vnd.microsoft.error',
              value: {
                code: 'InternalServerError',
                message: 'The action could not be saved. Try again.',
              },
            }
          : { error: 'The message could not be saved. Try again.' },
      };
    }
  }

  private async deliver(
    conversationId: string,
    threadId: string | undefined,
    activity: IMessageActivityInput | ITypingActivityInput,
    update = false,
  ): Promise<TeamsSdkSendResult> {
    if (!this.started)
      throw new Error(
        'Teams is disconnected. Reconnect the account before sending.',
      );
    const canonicalId = conversationId.split(';messageid=')[0]!;
    const route = await this.routeStore.get({
      providerAccountId: this.options.providerAccountId,
      conversationJid: `teams:${canonicalId}`,
    });
    if (!route)
      throw new Error(
        'No saved Teams route. Send a message to this bot in Teams before retrying delivery.',
      );
    if (route.tenantId !== this.credentials.tenantId)
      throw new Error(
        'The saved Teams route belongs to another tenant. Send a new message to this bot in Teams.',
      );
    let externalMessageId: string | undefined;
    try {
      const api = this.app.api.fromServiceUrl({ serviceUrl: route.serviceUrl });
      // Thread addressing must survive activities that omit conversation type.
      const destination = threadId
        ? `${canonicalId};messageid=${threadId}`
        : canonicalId;
      const payload = {
        ...activity,
        channelId: route.channelId,
        from: { id: route.botId, name: '' },
        conversation: { id: destination, tenantId: route.tenantId },
        ...(threadId ? { replyToId: threadId } : {}),
      };
      // The SDK's low-level API interpolates IDs directly into URL paths.
      const encodedConversation = encodeURIComponent(destination);
      const result = update
        ? await api.conversations.updateActivity(
            encodedConversation,
            encodeURIComponent(activity.id!),
            payload,
          )
        : await api.conversations.createActivity(encodedConversation, payload);
      externalMessageId = result.id;
    } catch (error) {
      logger.warn(
        {
          providerId: 'teams',
          outcome:
            error instanceof Error ? 'provider_error' : 'provider_failure',
        },
        'Teams delivery failed',
      );
      const status =
        error &&
        typeof error === 'object' &&
        'response' in error &&
        error.response &&
        typeof error.response === 'object' &&
        'status' in error.response
          ? error.response.status
          : undefined;
      // Only numeric HTTP error status may cross this boundary, so the channel
      // can split 413 payloads without retaining SDK request/response data.
      const safeStatus =
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 599
          ? { status }
          : {};
      throw Object.assign(
        new Error(
          'Teams delivery failed. Check the bot credentials and Teams connection, then retry.',
        ),
        safeStatus,
      );
    }
    return { externalMessageId };
  }

  sendMessage(
    input: Parameters<TeamsSdkClient['sendMessage']>[0],
  ): Promise<TeamsSdkSendResult> {
    return this.deliver(input.conversationId, input.threadId, {
      type: 'message',
      text: input.text,
      textFormat: 'markdown',
    });
  }

  sendAdaptiveCard(
    input: Parameters<NonNullable<TeamsSdkClient['sendAdaptiveCard']>>[0],
  ): Promise<TeamsSdkSendResult> {
    return this.deliver(input.conversationId, input.threadId, {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: input.card,
        },
      ],
    });
  }

  async sendTyping(input: {
    conversationId: string;
    threadId?: string;
  }): Promise<void> {
    await this.deliver(input.conversationId, input.threadId, {
      type: 'typing',
    });
  }

  updateAdaptiveCard(
    input: TeamsSdkAdaptiveCardUpdate,
  ): Promise<TeamsSdkSendResult> {
    return this.deliver(
      input.conversationId,
      input.threadId,
      {
        type: 'message',
        id: input.messageId,
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: input.card,
          },
        ],
      },
      true,
    );
  }
}

export function createMicrosoftTeamsSdkClient(
  credentials: TeamsChannelCredentials,
  options: {
    providerAccountId: string;
    inboundProviderAccountIds?: string[];
    routeStore: TeamsConversationRouteStore;
  },
): TeamsSdkClient {
  return new MicrosoftTeamsSdkClient(credentials, options);
}
