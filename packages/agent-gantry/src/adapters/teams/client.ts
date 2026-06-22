import { randomUUID } from 'node:crypto';
import type {
  GantryClientConfig,
  GantryDispatchResult,
  GantryExternalNotificationCardRequest,
  GantryExternalPlatformEventRequest,
  GantryTeamsConversationReferenceStatus,
  GantryTeamsThreadReplyRequest,
} from './types.js';
import { signExternalEventRequest } from './signing.js';
import {
  asRecord,
  gantryHttpError,
  parseResponseBody,
  readString,
  requireNonEmpty,
} from '../../shared/helpers.js';

export class GantryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly eventSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GantryClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey?.trim() ?? '';
    this.eventSecret = config.eventSecret?.trim() ?? '';
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  readonly notifications = {
    sendCard: async (
      input: GantryExternalNotificationCardRequest,
    ): Promise<GantryDispatchResult> => {
      return await this.sendExternalNotificationCard(input);
    },
    sendEvent: async (
      input: GantryExternalPlatformEventRequest,
    ): Promise<GantryDispatchResult> => {
      return await this.sendExternalPlatformEvent(input);
    },
  };

  readonly teams = {
    sendThreadReply: async (
      input: GantryTeamsThreadReplyRequest,
    ): Promise<GantryDispatchResult> => {
      return await this.sendTeamsThreadReply(input);
    },
    getConversationReferenceStatus: async (
      conversationId: string,
    ): Promise<GantryTeamsConversationReferenceStatus> => {
      return await this.getTeamsConversationReferenceStatus(conversationId);
    },
  };

  async sendExternalNotificationCard(
    input: GantryExternalNotificationCardRequest,
  ): Promise<GantryDispatchResult> {
    return await this.sendExternalPlatformEvent({
      integrationId: input.integrationId,
      eventId: input.eventId,
      eventType: 'notification.card.requested',
      occurredAt: input.occurredAt,
      target: {
        teamsChannelId: requireNonEmpty(
          input.target.teamsChannelId,
          'target.teamsChannelId',
        ),
        scopeId: input.target.scopeId ?? null,
        scopeName: input.target.scopeName ?? null,
      },
      payload: input.payload,
    });
  }

  async sendExternalPlatformEvent(
    input: GantryExternalPlatformEventRequest,
  ): Promise<GantryDispatchResult> {
    if (!this.eventSecret) {
      throw new Error(
        'Gantry eventSecret is required to send external platform events.',
      );
    }

    const path = '/v1/integrations/platform-events';
    const body = {
      integrationId: requireNonEmpty(input.integrationId, 'integrationId'),
      eventId: requireNonEmpty(input.eventId, 'eventId'),
      eventType: requireNonEmpty(input.eventType, 'eventType'),
      occurredAt: requireNonEmpty(input.occurredAt, 'occurredAt'),
      ...(input.target ? { target: input.target } : {}),
      payload: input.payload,
    };
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const signature = signExternalEventRequest({
      secret: this.eventSecret,
      method: 'POST',
      path,
      timestamp,
      nonce,
      rawBody,
    });

    return await this.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gantry-external-event-timestamp': timestamp,
        'x-gantry-external-event-nonce': nonce,
        'x-gantry-external-event-signature': signature,
      },
      body: rawBody,
    });
  }

  async sendTeamsThreadReply(
    input: GantryTeamsThreadReplyRequest,
  ): Promise<GantryDispatchResult> {
    this.requireApiKey('send Teams thread replies');
    const path = input.path?.trim() || '/v1/providers/teams/thread-replies';
    return await this.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        conversationId: requireNonEmpty(input.conversationId, 'conversationId'),
        replyToId: requireNonEmpty(input.replyToId, 'replyToId'),
        text: requireNonEmpty(input.text, 'text'),
      }),
    });
  }

  async getTeamsConversationReferenceStatus(
    conversationId: string,
  ): Promise<GantryTeamsConversationReferenceStatus> {
    this.requireApiKey('read Teams conversation readiness');
    const normalized = conversationId.trim();
    if (!normalized) {
      return { exists: false, conversationId };
    }

    const response = await this.rawRequest(
      `/v1/providers/teams/conversation-references/${encodeURIComponent(normalized)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
        },
      },
    );
    if (response.status === 404) {
      return { exists: false, conversationId: normalized };
    }
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw gantryHttpError(
        'Gantry Teams readiness check failed',
        response.status,
        body,
      );
    }
    const payload = asRecord(body);
    return {
      exists: payload?.exists === true,
      conversationId: readString(payload, 'conversationId') ?? normalized,
      conversationJid: readString(payload, 'conversationJid'),
      tenantId: readString(payload, 'tenantId'),
      botId: readString(payload, 'botId'),
      updatedAt: readString(payload, 'updatedAt'),
    };
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<GantryDispatchResult> {
    const response = await this.rawRequest(path, init);
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw gantryHttpError('Gantry request failed', response.status, body);
    }
    return {
      accepted: true,
      statusCode: response.status,
      body,
    };
  }

  private async rawRequest(path: string, init: RequestInit): Promise<Response> {
    return await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private requireApiKey(action: string): void {
    if (!this.apiKey) {
      throw new Error(`Gantry apiKey is required to ${action}.`);
    }
  }
}

export function createGantryClient(config: GantryClientConfig): GantryClient {
  return new GantryClient(config);
}

export async function sendExternalNotificationCard(
  config: GantryClientConfig,
  input: GantryExternalNotificationCardRequest,
): Promise<GantryDispatchResult> {
  return await createGantryClient(config).sendExternalNotificationCard(input);
}

export async function sendExternalPlatformEvent(
  config: GantryClientConfig,
  input: GantryExternalPlatformEventRequest,
): Promise<GantryDispatchResult> {
  return await createGantryClient(config).sendExternalPlatformEvent(input);
}

export async function sendTeamsThreadReply(
  config: GantryClientConfig,
  input: GantryTeamsThreadReplyRequest,
): Promise<GantryDispatchResult> {
  return await createGantryClient(config).sendTeamsThreadReply(input);
}

export async function getTeamsConversationReferenceStatus(
  config: GantryClientConfig,
  conversationId: string,
): Promise<GantryTeamsConversationReferenceStatus> {
  return await createGantryClient(config).getTeamsConversationReferenceStatus(
    conversationId,
  );
}
