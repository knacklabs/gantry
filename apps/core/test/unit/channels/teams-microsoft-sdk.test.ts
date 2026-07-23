import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { Activity } from '@microsoft/agents-activity';

import {
  buildMicrosoftTeamsAuthConfiguration,
  MicrosoftTeamsSdkClient,
} from '../../../src/channels/teams-microsoft-sdk.js';

const credentials = {
  clientId: 'bot-app-id',
  clientSecret: 'secret',
  tenantId: 'tenant-id',
};

describe('MicrosoftTeamsSdkClient', () => {
  it('registers the bot credentials as the default Microsoft connection', () => {
    const auth = buildMicrosoftTeamsAuthConfiguration(credentials);

    expect(auth.connections?.get('serviceConnection')).toEqual(credentials);
    expect(auth.connectionsMap).toEqual([
      { serviceUrl: '*', connection: 'serviceConnection' },
    ]);
  });

  it('authenticates and maps an inbound Teams activity with its durable conversation reference', async () => {
    const inbound = vi.fn(async () => undefined);
    const activity = Activity.fromObject({
      type: 'message',
      id: 'activity-1',
      text: '<at>TenderBot</at> status?',
      channelId: 'msteams',
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      conversation: {
        id: 'conversation-1;messageid=root-message-1',
        name: 'Tender thread',
        conversationType: 'channel',
        tenantId: 'tenant-id',
      },
      from: { id: 'teams-user-1', aadObjectId: 'aad-user-1', name: 'User' },
      recipient: { id: 'bot-app-id', name: 'TenderBot' },
      channelData: {
        tenant: { id: 'tenant-id' },
        channel: { id: 'channel-1' },
      },
      entities: [
        {
          type: 'mention',
          text: '<at>TenderBot</at>',
          mentioned: { id: 'bot-app-id', name: 'TenderBot' },
        },
      ],
    });
    const process = vi.fn(async (_request, response, logic) => {
      await logic({ activity });
      response.status(200).end();
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process, continueConversation: vi.fn() } as never,
      authorize: (async (request, _response, next) => {
        request.user = { aud: 'bot-app-id' };
        next();
      }) as never,
    });
    expect(client.getAuthenticatedConversationRegistrationCount()).toBe(0);
    await client.start({ credentials, onMessage: inbound });

    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    });
    const response = responseStub();
    await client.handleHttpIngress!(request as never, response as never, {
      type: 'message',
    });

    expect(process).toHaveBeenCalledOnce();
    expect(client.getAuthenticatedConversationRegistrationCount()).toBe(1);
    expect(inbound).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1;messageid=root-message-1',
        senderId: 'aad-user-1',
        threadId: 'root-message-1',
        conversationReference: expect.objectContaining({
          channelId: 'msteams',
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          conversation: expect.objectContaining({
            id: 'conversation-1;messageid=root-message-1',
          }),
        }),
        providerData: expect.objectContaining({
          tenantId: 'tenant-id',
          channelId: 'channel-1',
          conversationExternalRef: {
            microsoftConversationReference: expect.objectContaining({
              conversation: expect.objectContaining({
                id: 'conversation-1;messageid=root-message-1',
              }),
            }),
          },
          mentions: [
            expect.objectContaining({ id: 'bot-app-id', name: 'TenderBot' }),
          ],
        }),
      }),
    );
  });

  it('normalizes Teams quoted replies from entity metadata', async () => {
    const inbound = vi.fn(async () => undefined);
    const process = vi.fn(async (request, response, logic) => {
      await logic({ activity: Activity.fromObject(request.body) });
      response.status(200).end();
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process, continueConversation: vi.fn() } as never,
      authorize: (async (request, _response, next) => {
        request.user = { aud: 'bot-app-id' };
        next();
      }) as never,
    });
    await client.start({ credentials, onMessage: inbound });

    await client.handleHttpIngress!(
      Object.assign(new EventEmitter(), {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      }) as never,
      responseStub() as never,
      {
        type: 'message',
        id: 'reply-activity-1',
        text: 'A1B2',
        replyToId: 'thread-root-1',
        channelId: 'msteams',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        conversation: { id: 'conversation-1', tenantId: 'tenant-id' },
        from: { id: 'teams-user-1', aadObjectId: 'aad-user-1' },
        recipient: { id: 'bot-app-id' },
        entities: [
          {
            type: 'quotedReply',
            quotedReply: { messageId: 'captcha-message-1' },
          },
        ],
      },
    );

    expect(inbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'A1B2',
        replyToId: 'captcha-message-1',
        threadId: 'captcha-message-1',
      }),
    );
  });

  it('normalizes and removes the Teams quoted-reply text marker', async () => {
    const inbound = vi.fn(async () => undefined);
    const process = vi.fn(async (request, response, logic) => {
      await logic({ activity: Activity.fromObject(request.body) });
      response.status(200).end();
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process, continueConversation: vi.fn() } as never,
      authorize: (async (request, _response, next) => {
        request.user = { aud: 'bot-app-id' };
        next();
      }) as never,
    });
    await client.start({ credentials, onMessage: inbound });

    await client.handleHttpIngress!(
      Object.assign(new EventEmitter(), {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      }) as never,
      responseStub() as never,
      {
        type: 'message',
        id: 'reply-activity-2',
        text: ' <quoted messageId="captcha-message-2"/> C3D4 ',
        channelId: 'msteams',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        conversation: { id: 'conversation-2', tenantId: 'tenant-id' },
        from: { id: 'teams-user-1', aadObjectId: 'aad-user-1' },
        recipient: { id: 'bot-app-id' },
      },
    );

    expect(inbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'C3D4',
        replyToId: 'captcha-message-2',
        threadId: 'captcha-message-2',
      }),
    );
  });

  it('unwraps a real Action.Execute payload and returns the required invoke response', async () => {
    const inbound = vi.fn(async () => undefined);
    const sendActivity = vi.fn(async () => ({ id: '' }));
    const process = vi.fn(async (request, response, logic) => {
      const activity = Activity.fromObject(request.body);
      await logic({ activity, sendActivity });
      const invokeActivity = sendActivity.mock.calls[0]?.[0] as Activity;
      const invoke = invokeActivity.value as {
        status: number;
        body: Record<string, unknown>;
      };
      response.status(invoke.status);
      response.setHeader('content-type', 'application/json');
      response.send(invoke.body);
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process, continueConversation: vi.fn() } as never,
      authorize: (async (request, _response, next) => {
        request.user = { aud: 'bot-app-id' };
        next();
      }) as never,
    });
    await client.start({ credentials, onMessage: inbound });

    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    });
    const response = responseStub();
    await client.handleHttpIngress!(request as never, response as never, {
      type: 'invoke',
      name: 'adaptiveCard/action',
      id: 'action-activity-1',
      channelId: 'msteams',
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      conversation: {
        id: 'conversation-1;messageid=root-message-1',
        conversationType: 'channel',
        tenantId: 'tenant-id',
      },
      from: {
        id: 'teams-user-1',
        aadObjectId: 'aad-user-1',
        name: 'User',
      },
      recipient: { id: 'bot-app-id', name: 'TenderBot' },
      value: {
        action: {
          type: 'Action.Execute',
          verb: 'request_analysis',
          data: {
            action: 'application_action',
            actionId: 'notice-1:request_analysis',
            eventId: 'notice-1',
          },
        },
        trigger: 'manual',
      },
    });

    expect(inbound).toHaveBeenCalledWith(
      expect.objectContaining({
        value: {
          action: 'application_action',
          actionId: 'notice-1:request_analysis',
          eventId: 'notice-1',
        },
        providerData: expect.objectContaining({
          actionType: 'Action.Execute',
          actionVerb: 'request_analysis',
          actionValue: {
            action: 'application_action',
            actionId: 'notice-1:request_analysis',
            eventId: 'notice-1',
          },
        }),
      }),
    );
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'invokeResponse',
        value: {
          status: 200,
          body: {
            statusCode: 200,
            type: 'application/vnd.microsoft.activity.message',
            value: 'Action received.',
          },
        },
      }),
    );
    expect(response).toMatchObject({ statusCode: 200, writableEnded: true });
    expect(response.write).toHaveBeenCalledWith(
      JSON.stringify({
        statusCode: 200,
        type: 'application/vnd.microsoft.activity.message',
        value: 'Action received.',
      }),
    );
  });

  it('keeps a flat Action.Submit value compatible without emitting an invoke response', async () => {
    const inbound = vi.fn(async () => undefined);
    const sendActivity = vi.fn(async () => ({ id: '' }));
    const process = vi.fn(async (request, response, logic) => {
      await logic({
        activity: Activity.fromObject(request.body),
        sendActivity,
      });
      response.status(200).end();
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process, continueConversation: vi.fn() } as never,
      authorize: (async (request, _response, next) => {
        request.user = { aud: 'bot-app-id' };
        next();
      }) as never,
    });
    await client.start({ credentials, onMessage: inbound });

    await client.handleHttpIngress!(
      Object.assign(new EventEmitter(), {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      }) as never,
      responseStub() as never,
      {
        type: 'message',
        id: 'submit-activity-1',
        channelId: 'msteams',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        conversation: { id: 'conversation-1', tenantId: 'tenant-id' },
        from: { id: 'teams-user-1', aadObjectId: 'aad-user-1' },
        recipient: { id: 'bot-app-id' },
        value: {
          action: 'application_action',
          actionId: 'notice-1:watch',
          eventId: 'notice-1',
        },
      },
    );

    expect(inbound).toHaveBeenCalledWith(
      expect.objectContaining({
        value: {
          action: 'application_action',
          actionId: 'notice-1:watch',
          eventId: 'notice-1',
        },
      }),
    );
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it('returns an Adaptive Card error for a malformed Action.Execute envelope', async () => {
    const inbound = vi.fn(async () => undefined);
    const sendActivity = vi.fn(async () => ({ id: '' }));
    const process = vi.fn(async (request, response, logic) => {
      await logic({
        activity: Activity.fromObject(request.body),
        sendActivity,
      });
      const invokeActivity = sendActivity.mock.calls[0]?.[0] as Activity;
      const invoke = invokeActivity.value as {
        status: number;
        body: Record<string, unknown>;
      };
      response.status(invoke.status).send(invoke.body);
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process, continueConversation: vi.fn() } as never,
      authorize: (async (request, _response, next) => {
        request.user = { aud: 'bot-app-id' };
        next();
      }) as never,
    });
    await client.start({ credentials, onMessage: inbound });

    await client.handleHttpIngress!(
      Object.assign(new EventEmitter(), {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      }) as never,
      responseStub() as never,
      {
        type: 'invoke',
        name: 'adaptiveCard/action',
        id: 'action-activity-2',
        channelId: 'msteams',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        conversation: { id: 'conversation-1', tenantId: 'tenant-id' },
        from: { id: 'teams-user-1', aadObjectId: 'aad-user-1' },
        recipient: { id: 'bot-app-id' },
        value: {
          action: { type: 'Action.Execute', verb: 'request_analysis' },
        },
      },
    );

    expect(inbound).not.toHaveBeenCalled();
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'invokeResponse',
        value: {
          status: 200,
          body: expect.objectContaining({
            statusCode: 400,
            type: 'application/vnd.microsoft.error',
          }),
        },
      }),
    );
  });

  it('does not register a conversation when Microsoft authorization rejects ingress', async () => {
    const process = vi.fn();
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process, continueConversation: vi.fn() } as never,
      authorize: (async (_request, response) => {
        response.status(401).send({ 'jwt-auth-error': 'invalid token' });
      }) as never,
    });
    await client.start({
      credentials,
      onMessage: vi.fn(async () => undefined),
    });

    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      headers: { authorization: 'Bearer rejected-token' },
    });
    const response = responseStub();
    await client.handleHttpIngress!(request as never, response as never, {
      type: 'message',
    });

    expect(process).not.toHaveBeenCalled();
    expect(client.getAuthenticatedConversationRegistrationCount()).toBe(0);
    expect(response).toMatchObject({ statusCode: 401, writableEnded: true });
  });

  it('bounds authenticated conversation references while retaining recent routes', async () => {
    const sendActivity = vi.fn(async () => ({ id: 'sent-message-1' }));
    const continueConversation = vi.fn(async (_appId, _reference, logic) => {
      await logic({ sendActivity });
    });
    const process = vi.fn(async (request, response, logic) => {
      await logic({ activity: Activity.fromObject(request.body) });
      response.status(200).end();
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process, continueConversation } as never,
      authorize: (async (request, _response, next) => {
        request.user = { aud: 'bot-app-id' };
        next();
      }) as never,
    });
    await client.start({
      credentials,
      onMessage: vi.fn(async () => undefined),
    });

    for (let index = 0; index <= 5_000; index += 1) {
      const request = Object.assign(new EventEmitter(), {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      });
      await client.handleHttpIngress!(
        request as never,
        responseStub() as never,
        {
          type: 'message',
          id: `activity-${index}`,
          channelId: 'msteams',
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          conversation: { id: `conversation-${index}` },
          from: { id: 'teams-user-1' },
          recipient: { id: 'bot-app-id' },
        },
      );
    }

    expect(client.getAuthenticatedConversationRegistrationCount()).toBe(5_000);
    await expect(
      client.sendMessage({
        conversationId: 'conversation-5000',
        text: 'recent',
      }),
    ).resolves.toEqual({ externalMessageId: 'sent-message-1' });
    await expect(
      client.sendMessage({ conversationId: 'conversation-0', text: 'oldest' }),
    ).rejects.toThrow(
      'No Microsoft Teams conversation reference is registered for conversation-0.',
    );
  });

  it('uses a persisted reference and thread id for proactive replies', async () => {
    const sendActivity = vi.fn(async () => ({ id: 'sent-message-1' }));
    const continueConversation = vi.fn(async (_appId, _reference, logic) => {
      await logic({ sendActivity });
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process: vi.fn(), continueConversation } as never,
      authorize: vi.fn() as never,
    });

    await expect(
      client.sendMessage({
        conversationId: 'conversation-1',
        threadId: 'root-message-1',
        text: 'Final answer',
        conversationReference: {
          channelId: 'msteams',
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          conversation: { id: 'conversation-1' },
        },
      }),
    ).resolves.toEqual({ externalMessageId: 'sent-message-1' });
    expect(continueConversation).toHaveBeenCalledWith(
      'bot-app-id',
      expect.objectContaining({ conversation: { id: 'conversation-1' } }),
      expect.any(Function),
    );
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        text: 'Final answer',
        replyToId: 'root-message-1',
      }),
    );
    expect(client.getAuthenticatedConversationRegistrationCount()).toBe(1);
  });

  it('normalizes a thread reference to the base channel for a new root message', async () => {
    const sendActivity = vi.fn(async () => ({ id: 'new-root-message-1' }));
    const continueConversation = vi.fn(async (_appId, _reference, logic) => {
      await logic({ sendActivity });
    });
    const client = new MicrosoftTeamsSdkClient(credentials, {
      adapter: { process: vi.fn(), continueConversation } as never,
      authorize: vi.fn() as never,
    });

    await client.sendAdaptiveCard({
      conversationId: 'conversation-1;messageid=previous-root-message',
      text: 'New tender notice',
      card: { type: 'AdaptiveCard', version: '1.2', body: [] },
      conversationReference: {
        channelId: 'msteams',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        activityId: 'previous-reply',
        conversation: {
          id: 'conversation-1;messageid=previous-root-message',
          conversationType: 'channel',
        },
      },
    });

    expect(continueConversation).toHaveBeenCalledWith(
      'bot-app-id',
      expect.objectContaining({
        conversation: expect.objectContaining({ id: 'conversation-1' }),
      }),
      expect.any(Function),
    );
    const outboundReference = continueConversation.mock.calls[0]?.[1] as {
      activityId?: string;
    };
    expect(outboundReference.activityId).toBeUndefined();
    expect(sendActivity).toHaveBeenCalledWith(
      expect.not.objectContaining({ replyToId: expect.anything() }),
    );
  });
});

function responseStub() {
  const response = {
    statusCode: 0,
    writableEnded: false,
    headersSent: false,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(() => {
      response.writableEnded = true;
    }),
  };
  return response;
}
