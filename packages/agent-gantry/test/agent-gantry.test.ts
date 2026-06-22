import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildExternalNotificationAdaptiveCard,
  createAnthropicStructuredModelProvider,
  createBotFrameworkTeamsTransport,
  createFirecrawlCrawlProvider,
  createFirecrawlDiscoveryToolProviderSet,
  createFirecrawlFetchProvider,
  createFirecrawlMapProvider,
  createFirecrawlSearchProvider,
  createHttpFetchProvider,
  createGantryClient,
  createGantryRuntime,
  createPgGantryRuntimeStorage,
  createStructuredModelTaskRunner,
  createTavilySearchProvider,
  parseExternalCardAction,
  signExternalCardAction,
  signExternalEventRequest,
  verifyExternalCardAction,
  verifyExternalEventSignature,
  verifyWebhookSignature,
  type BotFrameworkAdapterLike,
} from '../src/index.js';

describe('@cawstudios/agent-gantry', () => {
  it('maps Tavily search responses into structured search results', async () => {
    const provider = createTavilySearchProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                url: 'https://example.gov/Resources',
                title: 'Resources',
                content: 'Bid notices',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      provider.search({ query: 'karnataka Resources', limit: 1 }),
    ).resolves.toMatchObject({
      provider: 'tavily',
      items: [
        {
          url: 'https://example.gov/Resources',
          title: 'Resources',
          snippet: 'Bid notices',
        },
      ],
    });
  });

  it('maps Firecrawl search responses into structured search results', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const provider = createFirecrawlSearchProvider({
      apiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: [
              {
                url: 'https://example.gov/Resources',
                title: 'Resources',
                markdown: 'Bid notices and procurement updates',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      provider.search({ query: 'karnataka Resources', limit: 1 }),
    ).resolves.toMatchObject({
      provider: 'firecrawl-search',
      items: [
        {
          url: 'https://example.gov/Resources',
          title: 'Resources',
          snippet: 'Bid notices and procurement updates',
        },
      ],
    });
    expect(requestBody).toEqual({ query: 'karnataka Resources', limit: 1 });
  });

  it('maps Firecrawl map responses into structured link results', async () => {
    const provider = createFirecrawlMapProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            links: [
              'https://example.gov/Resources',
              { url: 'https://example.gov/procurement', title: 'Procurement' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      provider.map({ url: 'https://example.gov', limit: 2 }),
    ).resolves.toMatchObject({
      startUrl: 'https://example.gov',
      provider: 'firecrawl-map',
      links: [
        { url: 'https://example.gov/Resources' },
        { url: 'https://example.gov/procurement', title: 'Procurement' },
      ],
    });
  });

  it('creates source discovery providers with search, map, http fetch, and crawl', () => {
    const tools = createFirecrawlDiscoveryToolProviderSet({
      apiKey: 'test-key',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    expect(tools.search).toBeDefined();
    expect(tools.map).toBeDefined();
    expect(tools.fetch).toBeDefined();
    expect(tools.crawl).toBeDefined();
  });

  it('maps Anthropic message responses into structured JSON model output', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      taskModels: { 'task.test': 'claude-task' },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      model.generateJson({
        taskType: 'task.test',
        instructions: 'Return JSON.',
        input: { value: 1 },
        correlationId: 'corr-1',
      }),
    ).resolves.toEqual({ status: 'completed' });
    expect(requestBody).toMatchObject({
      model: 'claude-task',
      max_tokens: 4096,
      messages: [{ role: 'user' }],
    });
    expect(JSON.stringify(requestBody)).not.toContain('test-key');
  });

  it('sends Anthropic structured task image attachments as vision blocks', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      model.generateJson({
        taskType: 'task.vision',
        instructions: 'Return JSON.',
        input: { value: 1 },
        attachments: [
          {
            label: 'captcha',
            mimeType: 'image/png',
            base64: 'base64-image',
            purpose: 'captcha_ocr',
          },
        ],
      }),
    ).resolves.toEqual({ status: 'completed' });
    const messages = requestBody?.messages;
    expect(Array.isArray(messages)).toBe(true);
    const firstMessage = (messages as Array<{ content?: unknown }>)[0];
    expect(firstMessage.content).toContainEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'base64-image',
      },
    });
  });

  it('fetches and summarizes HTTP pages with blocking signals', async () => {
    const provider = createHttpFetchProvider({
      fetchImpl: async () =>
        new Response(
          '<html><title>Portal</title><body>Please login to continue</body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' },
          },
        ),
    });

    await expect(
      provider.fetch({ url: 'https://example.gov' }),
    ).resolves.toMatchObject({
      title: 'Portal',
      blockedReason: 'login_required',
      provider: 'http-fetch',
    });
  });

  it('maps Firecrawl scrape responses into structured fetch results', async () => {
    const provider = createFirecrawlFetchProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: 'Public resource notices',
              metadata: {
                sourceURL: 'https://example.gov',
                title: 'Procurement Portal',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      provider.fetch({ url: 'https://example.gov' }),
    ).resolves.toMatchObject({
      url: 'https://example.gov',
      title: 'Procurement Portal',
      text: 'Public resource notices',
      provider: 'firecrawl-scrape',
    });
  });

  it('maps Firecrawl crawl responses into structured crawl pages', async () => {
    const provider = createFirecrawlCrawlProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                markdown: 'Resource page',
                metadata: {
                  sourceURL: 'https://example.gov/Resources',
                  title: 'Resources',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      provider.crawl({ url: 'https://example.gov', limit: 1 }),
    ).resolves.toMatchObject({
      startUrl: 'https://example.gov',
      provider: 'firecrawl',
      pages: [
        {
          url: 'https://example.gov/Resources',
          title: 'Resources',
          text: 'Resource page',
        },
      ],
    });
  });

  it('fails search provider construction clearly when the Tavily key is missing', () => {
    expect(() => createTavilySearchProvider({ apiKey: '' })).toThrow(
      'TAVILY_API_KEY',
    );
  });

  it('fails Firecrawl provider construction clearly when the Firecrawl key is missing', () => {
    expect(() => createFirecrawlSearchProvider({ apiKey: '' })).toThrow(
      'FIRECRAWL_API_KEY',
    );
    expect(() => createFirecrawlFetchProvider({ apiKey: '' })).toThrow(
      'FIRECRAWL_API_KEY',
    );
    expect(() => createFirecrawlCrawlProvider({ apiKey: '' })).toThrow(
      'FIRECRAWL_API_KEY',
    );
  });

  it('signs and verifies external event requests', () => {
    const input = {
      secret: 'secret',
      method: 'post',
      path: '/v1/integrations/platform-events',
      timestamp: '1000',
      nonce: 'nonce',
      rawBody: '{"ok":true}',
    };
    const signature = signExternalEventRequest(input);
    expect(
      verifyExternalEventSignature({ ...input, signature, nowMs: 1000 }),
    ).toBe(true);
    expect(
      verifyExternalEventSignature({ ...input, signature: 'bad', nowMs: 1000 }),
    ).toBe(false);
  });

  it('verifies webhook signatures', () => {
    const secret = 'secret';
    const timestamp = '1000';
    const eventId = 'evt_1';
    const eventType = 'delivery.status';
    const rawBody = '{"ok":true}';
    const signature = cryptoSign(
      secret,
      `${timestamp}.${eventId}.${eventType}.${rawBody}`,
    );
    expect(
      verifyWebhookSignature({
        secret,
        timestamp,
        eventId,
        eventType,
        rawBody,
        signature,
        nowMs: 1000,
      }),
    ).toBe(true);
  });

  it('renders signed Teams submit actions for embedded notification cards', () => {
    const card = buildExternalNotificationAdaptiveCard({
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      actionSecret: 'secret',
      nowMs: 1000,
      payload: {
        subjectId: 'subject-1',
        notificationCard: {
          schemaVersion: 'external.notification.card.v1',
          renderer: 'gantry_adaptive_card',
          title: 'Resource',
          scopeId: 'scope-1',
          sourceConversationId: '19:conversation',
          teamsTenantId: 'tenant-1',
          actions: [
            {
              actionType: 'track_subject',
              label: 'Watch',
              presentation: 'submit',
              platformOperation: 'mark_resource',
            },
          ],
        },
      },
    });

    const action = (card?.actions as Array<{ data: unknown }>)[0]?.data;
    const parsed = parseExternalCardAction(action);
    expect(parsed).toMatchObject({
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      subjectId: 'subject-1',
      scopeId: 'scope-1',
      sourceScopeId: 'scope-1',
      sourceConversationId: '19:conversation',
      teamsTenantId: 'tenant-1',
      actionType: 'track_subject',
      platformOperation: 'mark_resource',
    });
    expect(
      parsed &&
        verifyExternalCardAction({
          action: parsed,
          secret: 'secret',
          nowMs: 1000,
        }),
    ).toBe(true);
  });

  it('signs v2 card actions with operation and request context', () => {
    const signed = signExternalCardAction({
      secret: 'secret',
      signatureVersion: 'v2',
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-review-1',
      requestId: 'request-1',
      subjectId: 'resource-1',
      scopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'approve_request',
      platformOperation: 'approveRequest',
      nowMs: 1000,
    });
    const action = parseExternalCardAction({
      action: 'external_card_action',
      signatureVersion: signed.signatureVersion,
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-review-1',
      requestId: 'request-1',
      subjectId: 'resource-1',
      scopeId: 'workspace-1',
      sourcescopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'approve_request',
      platformOperation: 'approveRequest',
      nonce: signed.nonce,
      expiresAt: signed.expiresAt,
      signature: signed.signature,
    });

    expect(action).toMatchObject({
      signatureVersion: 'v2',
      requestId: 'request-1',
      platformOperation: 'approveRequest',
    });
    expect(
      action &&
        verifyExternalCardAction({ action, secret: 'secret', nowMs: 1000 }),
    ).toBe(true);
    expect(
      action &&
        verifyExternalCardAction({
          action: {
            ...action,
            platformOperation: 'rejectRequest',
          },
          secret: 'secret',
          nowMs: 1000,
        }),
    ).toBe(false);
  });

  it('verifies card actions when Teams rewrites equivalent expiresAt strings', () => {
    const baseAction = {
      action: 'external_card_action',
      signatureVersion: 'v2' as const,
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      subjectId: 'subject-1',
      scopeId: 'workspace-1',
      sourcescopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'request_review',
      platformOperation: 'requestReviewApproval',
    };
    const signedWithMilliseconds = signExternalCardAction({
      secret: 'secret',
      ...baseAction,
      expiresAt: '2099-01-01T00:00:00.550Z',
      nonce: 'nonce-550',
    });
    const shortenedMillisecondsAction = parseExternalCardAction({
      ...baseAction,
      nonce: signedWithMilliseconds.nonce,
      expiresAt: '2099-01-01T00:00:00.55Z',
      signature: signedWithMilliseconds.signature,
    });

    expect(shortenedMillisecondsAction).toMatchObject({
      expiresAt: '2099-01-01T00:00:00.550Z',
    });
    expect(
      shortenedMillisecondsAction &&
        verifyExternalCardAction({
          action: shortenedMillisecondsAction,
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(true);

    const signedWithZeroMilliseconds = signExternalCardAction({
      secret: 'secret',
      ...baseAction,
      expiresAt: '2099-01-01T00:00:00.000Z',
      nonce: 'nonce-000',
    });
    const omittedZeroMillisecondsAction = parseExternalCardAction({
      ...baseAction,
      nonce: signedWithZeroMilliseconds.nonce,
      expiresAt: '2099-01-01T00:00:00Z',
      signature: signedWithZeroMilliseconds.signature,
    });

    expect(omittedZeroMillisecondsAction).toMatchObject({
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(
      omittedZeroMillisecondsAction &&
        verifyExternalCardAction({
          action: omittedZeroMillisecondsAction,
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(true);
  });

  it('keeps card action signatures strict after expiresAt normalization', () => {
    const signed = signExternalCardAction({
      secret: 'secret',
      signatureVersion: 'v2',
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      subjectId: 'subject-1',
      scopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'request_review',
      platformOperation: 'requestReviewApproval',
      nonce: 'nonce-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const action = parseExternalCardAction({
      action: 'external_card_action',
      signatureVersion: signed.signatureVersion,
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      subjectId: 'subject-1',
      scopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'request_review',
      platformOperation: 'requestReviewApproval',
      nonce: signed.nonce,
      expiresAt: '2099-01-01T00:00:00Z',
      signature: signed.signature,
    });

    expect(
      action &&
        verifyExternalCardAction({
          action: { ...action, platformOperation: 'trackSubject' },
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(false);
    expect(
      action &&
        verifyExternalCardAction({
          action: { ...action, subjectId: 'subject-2' },
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(false);
    expect(
      action &&
        verifyExternalCardAction({
          action: { ...action, nonce: 'nonce-2' },
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(false);
    expect(() =>
      signExternalCardAction({
        secret: 'secret',
        signatureVersion: 'v2',
        integrationId: 'external-workflow-bot',
        eventId: 'outbox-1',
        subjectId: 'subject-1',
        scopeId: 'workspace-1',
        sourceConversationId: '19:workspace',
        teamsTenantId: 'tenant-1',
        actionType: 'request_review',
        platformOperation: 'requestReviewApproval',
        expiresAt: 'not-a-date',
      }),
    ).toThrow('External card action expiration timestamp is invalid.');
  });

  it('sends notification card requests through the external platform event route', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> =
      [];
    const client = createGantryClient({
      baseUrl: 'http://gantry.test',
      eventSecret: 'secret',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202,
        });
      },
    });

    const result = await client.notifications.sendCard({
      integrationId: 'external-workflow-bot',
      eventId: 'evt_1',
      occurredAt: '2026-05-24T00:00:00.000Z',
      target: { teamsChannelId: 'channel', scopeId: 'workspace' },
      payload: { subjectId: 'subject-1' },
    });

    expect(result.statusCode).toBe(202);
    expect(calls[0]?.url).toBe(
      'http://gantry.test/v1/integrations/platform-events',
    );
    expect(
      (calls[0]?.init.headers as Record<string, string>)[
        'x-gantry-external-event-signature'
      ],
    ).toBeTruthy();
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      eventType: 'notification.card.requested',
      target: { teamsChannelId: 'channel' },
    });
  });

  it('sends Teams thread replies through the control route', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> =
      [];
    const client = createGantryClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'key',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202,
        });
      },
    });

    await client.teams.sendThreadReply({
      conversationId: 'conversation',
      replyToId: 'message',
      text: 'hello',
    });

    expect(calls[0]?.url).toBe(
      'http://gantry.test/v1/providers/teams/thread-replies',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      conversationId: 'conversation',
      replyToId: 'message',
      text: 'hello',
    });
  });

  it('accepts minimal Response-like fetch mocks', async () => {
    const client = createGantryClient({
      baseUrl: 'http://gantry.test',
      eventSecret: 'secret',
      fetchImpl: async () => ({ ok: true, status: 202 }) as Response,
    });

    await expect(
      client.notifications.sendEvent({
        integrationId: 'external-workflow-bot',
        eventId: 'evt_1',
        eventType: 'resource_processing_failed',
        occurredAt: '2026-05-24T00:00:00.000Z',
        payload: { subjectId: 'subject_1' },
      }),
    ).resolves.toMatchObject({ statusCode: 202 });
  });

  it('creates an embedded runtime without a control base URL', async () => {
    const messages: unknown[] = [];
    const runtime = createGantryRuntime({
      storage: {
        recordMessage: (input) => messages.push(input),
      },
      teams: {
        sendCard: () => ({ accepted: true, statusCode: 202 }),
        sendDm: () => ({ accepted: true, statusCode: 202 }),
        sendThreadReply: () => ({ accepted: true, statusCode: 202 }),
      },
      tasks: {
        runStructuredTask: async () => ({
          status: 'completed',
          output: { ok: true },
        }),
      },
    });

    await expect(
      runtime.teams.sendCard({
        conversationId: 'conversation',
        card: { type: 'AdaptiveCard' },
      }),
    ).resolves.toMatchObject({ statusCode: 202 });
    await expect(
      runtime.tasks.runStructuredTask({
        taskType: 'test',
        instructions: 'return ok',
        input: {},
      }),
    ).resolves.toMatchObject({ output: { ok: true } });
    await expect(
      runtime.teams.handleIncomingActivity({
        activity: {
          type: 'message',
          id: 'message',
          text: 'hello',
          conversation: { id: 'conversation' },
          from: { aadObjectId: 'user', name: 'User' },
          channelData: { tenant: { id: 'tenant' } },
        },
      }),
    ).resolves.toMatchObject({
      messageId: 'message',
      conversationId: 'conversation',
      teamsUserId: 'user',
    });
    expect(messages).toHaveLength(1);
  });

  it('normalizes Teams message.value card submits without requiring invoke activities', async () => {
    const actionValue = { action: 'external_card_action', eventId: 'outbox-1' };
    const runtime = createGantryRuntime({
      teams: {
        sendCard: () => ({ accepted: true, statusCode: 202 }),
        sendDm: () => ({ accepted: true, statusCode: 202 }),
        sendThreadReply: () => ({ accepted: true, statusCode: 202 }),
      },
    });

    await expect(
      runtime.teams.handleIncomingActivity({
        activity: {
          type: 'message',
          id: 'message-action-1',
          value: actionValue,
          conversation: { id: '19:workspace' },
          from: { aadObjectId: 'teams-user-1' },
          channelData: { tenant: { id: 'tenant-1' } },
        },
      }),
    ).resolves.toMatchObject({
      type: 'message',
      messageId: 'message-action-1',
      conversationId: '19:workspace',
      value: actionValue,
      teamsTenantId: 'tenant-1',
      teamsUserId: 'teams-user-1',
    });
  });

  it('stores Teams channel conversation references under the base channel id', async () => {
    const savedReferences: unknown[] = [];
    const activity = {
      type: 'message',
      id: 'message-action-1',
      serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
      conversation: {
        id: '19:channel@thread.tacv2;messageid=parent-card-1',
        isGroup: true,
        conversationType: 'channel',
      },
      from: { aadObjectId: 'teams-user-1', id: '29:user', name: 'User' },
      recipient: { id: '28:bot', name: 'Workflow Bot' },
      channelData: {
        channel: { id: '19:channel@thread.tacv2' },
        tenant: { id: 'tenant-1' },
      },
    };
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async (_req, _res, logic) => {
        await logic({ activity } as never);
      },
      continueConversation: async () => undefined,
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {
        saveTeamsConversationReference: (reference) =>
          savedReferences.push(reference),
      },
      adapter,
    });
    const seenActivities: unknown[] = [];

    await transport.handleHttpActivity?.({
      req: {} as never,
      res: {
        writableEnded: false,
        end: () => undefined,
        setHeader: () => undefined,
      } as never,
      onActivity: (incoming) => seenActivities.push(incoming),
    });

    expect(savedReferences[0]).toMatchObject({
      exists: true,
      conversationId: '19:channel@thread.tacv2',
      conversationJid: 'teams:19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
      tenantId: 'tenant-1',
      botId: '28:bot',
      teamsUserId: 'teams-user-1',
    });
    expect(seenActivities[0]).toMatchObject({
      conversationId: '19:channel@thread.tacv2;messageid=parent-card-1',
    });
  });

  it('finds historical Teams references stored with message-scoped conversation ids', async () => {
    const storage = createPgGantryRuntimeStorage({
      schema: 'gantry_runtime',
      pool: {
        query: async (_sql, values) => {
          expect(values).toEqual([
            'teams:19:channel@thread.tacv2',
            'teams:19:channel@thread.tacv2',
            '19:channel@thread.tacv2',
            '19:channel@thread.tacv2',
          ]);
          return {
            rows: [
              {
                conversation_jid:
                  'teams:19:channel@thread.tacv2;messageid=parent-card-1',
                conversation_id:
                  '19:channel@thread.tacv2;messageid=parent-card-1',
                service_url: 'https://smba.trafficmanager.net/in/tenant-1/',
                tenant_id: 'tenant-1',
                bot_id: '28:bot',
                teams_user_id: 'teams-user-1',
                raw_reference_json: JSON.stringify({
                  serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
                  conversation: {
                    id: '19:channel@thread.tacv2;messageid=parent-card-1',
                  },
                }),
                updated_at: new Date('2026-06-05T13:29:56.000Z'),
              },
            ],
          };
        },
      },
    });

    await expect(
      storage.getTeamsConversationReference?.('19:channel@thread.tacv2'),
    ).resolves.toMatchObject({
      exists: true,
      conversationId: '19:channel@thread.tacv2;messageid=parent-card-1',
      conversationJid: 'teams:19:channel@thread.tacv2;messageid=parent-card-1',
      tenantId: 'tenant-1',
      rawReferenceJson: expect.stringContaining('parent-card-1'),
    });
  });

  it('sends Teams cards through embedded Bot Framework transport', async () => {
    const sent: unknown[] = [];
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (_reference, logic) => {
        await logic({
          sendActivity: async (activity: unknown) => {
            sent.push(activity);
            return { id: 'teams-message-1' };
          },
        } as never);
      },
    };
    const storage = {
      getTeamsConversationReference: () => ({
        exists: true,
        conversationId: 'conversation',
        conversationJid: 'teams:conversation',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        rawReferenceJson: JSON.stringify({
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          conversation: { id: 'conversation' },
        }),
      }),
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage,
      adapter,
    });

    await expect(
      transport.sendCard({
        conversationId: 'conversation',
        card: { type: 'AdaptiveCard' },
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    expect(sent).toHaveLength(1);
  });

  it('sends Teams cards to the base channel when the stored reference is message-scoped', async () => {
    const sent: unknown[] = [];
    const references: unknown[] = [];
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (reference, logic) => {
        references.push(reference);
        await logic({
          sendActivity: async (activity: unknown) => {
            sent.push(activity);
            return { id: 'teams-message-1' };
          },
        } as never);
      },
    };
    const storage = {
      getTeamsConversationReference: (conversationId: string) => {
        expect(conversationId).toBe('19:channel@thread.tacv2');
        return {
          exists: true,
          conversationId: '19:channel@thread.tacv2;messageid=parent-card-1',
          conversationJid:
            'teams:19:channel@thread.tacv2;messageid=parent-card-1',
          serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
            conversation: {
              id: '19:channel@thread.tacv2;messageid=parent-card-1',
            },
          }),
        };
      },
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage,
      adapter,
    });

    await expect(
      transport.sendCard({
        conversationId: '19:channel@thread.tacv2',
        card: { type: 'AdaptiveCard' },
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });

    expect(references).toEqual([
      expect.objectContaining({
        conversation: { id: '19:channel@thread.tacv2' },
      }),
    ]);
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'message',
        attachments: [
          expect.objectContaining({ content: { type: 'AdaptiveCard' } }),
        ],
      }),
    ]);
  });

  it('sends Teams thread replies with a thread-scoped conversation reference', async () => {
    const sent: unknown[] = [];
    const references: unknown[] = [];
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (reference, logic) => {
        references.push(reference);
        await logic({
          sendActivity: async (activity: unknown) => {
            sent.push(activity);
            return { id: 'teams-reply-1' };
          },
        } as never);
      },
    };
    const lookedUp: string[] = [];
    const storage = {
      getTeamsConversationReference: (conversationId: string) => {
        lookedUp.push(conversationId);
        return {
          exists: true,
          conversationId,
          conversationJid: `teams:${conversationId}`,
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.trafficmanager.net/emea/',
            conversation: { id: conversationId },
          }),
        };
      },
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage,
      adapter,
    });

    await expect(
      transport.sendThreadReply({
        conversationId: '19:channel',
        replyToId: 'parent-message',
        text: 'hello',
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    await expect(
      transport.sendThreadReply({
        conversationId: '19:channel;messageid=parent-message',
        replyToId: 'parent-message',
        text: 'again',
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });

    expect(lookedUp).toEqual(['19:channel', '19:channel']);
    expect(references).toEqual([
      expect.objectContaining({
        conversation: { id: '19:channel;messageid=parent-message' },
      }),
      expect.objectContaining({
        conversation: { id: '19:channel;messageid=parent-message' },
      }),
    ]);
    expect(sent).toEqual([
      expect.objectContaining({ replyToId: 'parent-message', text: 'hello' }),
      expect.objectContaining({ replyToId: 'parent-message', text: 'again' }),
    ]);
  });

  it('returns a stable missing-reference result for Teams DMs', async () => {
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {},
      adapter: {
        processActivity: async () => undefined,
        continueConversation: async () => undefined,
      },
    });

    await expect(
      transport.sendDm({
        teamsUserId: 'user',
        text: 'hello',
      }),
    ).resolves.toMatchObject({
      accepted: false,
      statusCode: 409,
      body: { code: 'teams_personal_conversation_reference_missing' },
    });
  });

  it('creates a personal Teams conversation when only a channel reference is known', async () => {
    const sent: string[] = [];
    let createdConversation = false;
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {
        getTeamsPersonalConversationReference: () => ({
          exists: true,
          conversationId: '19:channel-thread',
          conversationJid: 'teams:19:channel-thread',
          serviceUrl: 'https://smba.test/',
          tenantId: 'tenant-1',
          teamsUserId: 'user-1',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.test/',
            user: { id: '29:user', aadObjectId: 'user-1' },
            bot: { id: '28:bot' },
            conversation: {
              id: '19:channel-thread',
              conversationType: 'channel',
              isGroup: true,
              tenantId: 'tenant-1',
            },
          }),
        }),
      },
      adapter: {
        processActivity: async () => undefined,
        continueConversation: async () => {
          throw new Error('should create a personal conversation first');
        },
        createConversation: async (
          _reference: unknown,
          parameters: { readonly isGroup?: boolean },
          logic: (context: {
            sendActivity(activity: { text?: string }): Promise<{ id: string }>;
          }) => Promise<void>,
        ) => {
          createdConversation = parameters.isGroup === false;
          await logic({
            sendActivity: async (activity) => {
              sent.push(activity.text ?? '');
              return { id: 'dm-message-1' };
            },
          });
        },
      },
    });

    await expect(
      transport.sendDm({
        teamsUserId: 'user-1',
        teamsTenantId: 'tenant-1',
        text: 'hello',
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    expect(createdConversation).toBe(true);
    expect(sent).toEqual(['hello']);
  });

  it('creates pg-backed runtime storage using the Gantry schema', async () => {
    const calls: unknown[][] = [];
    const storage = createPgGantryRuntimeStorage({
      pool: {
        query: async (...args: unknown[]) => {
          calls.push(args);
          return { rows: [] };
        },
      },
    });

    await storage.recordMessage?.({
      provider: 'teams',
      conversationId: 'conversation',
      messageId: 'message',
      occurredAt: '2026-05-25T00:00:00.000Z',
    });
    expect(String(calls[0]?.[0])).toContain(
      '"gantry_runtime"."runtime_messages"',
    );
  });

  it('creates, reads, and merges pg-backed user conversation state by full scope key', async () => {
    const calls: unknown[][] = [];
    const storage = createPgGantryRuntimeStorage({
      pool: {
        query: async (...args: unknown[]) => {
          calls.push(args);
          return {
            rows: [
              {
                provider: 'teams',
                tenant_id: 'tenant-1',
                user_id: 'user-1',
                conversation_id: 'conversation-1',
                conversation_scope_type: 'teams_thread',
                conversation_scope_id: 'reply-1',
                summary_text: 'Safe UX summary',
                state_json: { last_intent: 'document_qa' },
                last_subject_id: 'subject-1',
                last_seen_at: new Date('2026-06-01T00:00:00.000Z'),
                expires_at: new Date('2026-07-01T00:00:00.000Z'),
                created_at: new Date('2026-06-01T00:00:00.000Z'),
                updated_at: new Date('2026-06-01T00:00:00.000Z'),
              },
            ],
          };
        },
      },
    });
    const key = {
      provider: 'teams',
      tenantId: 'tenant-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      conversationScopeType: 'teams_thread',
      conversationScopeId: 'reply-1',
    };

    await expect(
      storage.upsertUserConversationState?.({
        ...key,
        summaryText: 'Safe UX summary',
        stateJson: { last_intent: 'document_qa' },
        lastSubjectId: 'subject-1',
        lastSeenAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      ...key,
      summaryText: 'Safe UX summary',
      stateJson: { last_intent: 'document_qa' },
    });
    await storage.getUserConversationState?.(key);
    await storage.mergeUserConversationState?.({
      ...key,
      summaryText: 'Safe follow-up',
      stateJson: { last_answered: true },
      lastSeenAt: '2026-06-01T00:01:00.000Z',
      expiresAt: '2026-07-01T00:01:00.000Z',
    });

    expect(String(calls[0]?.[0])).toContain(
      '"gantry_runtime"."user_conversation_state"',
    );
    expect(String(calls[1]?.[0])).toContain('expires_at > now()');
    expect(String(calls[2]?.[0])).toContain('state_json');
    expect(calls[1]?.[1]).toEqual([
      'teams',
      'tenant-1',
      'user-1',
      'conversation-1',
      'teams_thread',
      'reply-1',
    ]);
  });

  it('runs structured model tasks and records audit state', async () => {
    const audits: unknown[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () => ({
          recipeSnapshotJson: { steps: [] },
          validationReportJson: { valid: true },
        }),
      },
      storage: {
        recordStructuredTaskRun: (input) => audits.push(input),
      },
    });

    await expect(
      runner.runStructuredTask({
        taskType: 'recipe',
        instructions: 'return a recipe',
        input: { websiteId: 'website' },
        correlationId: 'website',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      output: { recipeSnapshotJson: { steps: [] } },
    });
    expect(audits).toHaveLength(1);
  });

  it('keeps successful structured tool evidence when sibling tools abort', async () => {
    const runner = createStructuredModelTaskRunner({
      tools: {
        search: {
          search: async () => ({
            provider: 'firecrawl-search',
            items: [
              {
                url: 'https://example.gov/Resources',
                title: 'Resource portal',
                snippet: 'Open bid notices',
              },
            ],
          }),
        },
        fetch: {
          fetch: async () => {
            throw new Error('This operation was aborted');
          },
        },
        crawl: {
          crawl: async () => {
            throw new Error('This operation was aborted');
          },
        },
      },
      model: {
        generateJson: async (input) => {
          const toolContext = input.input.toolContext as {
            search?: Array<{
              items?: Array<{ title?: unknown; url?: unknown }>;
            }>;
          };
          const firstItem = toolContext.search?.[0]?.items?.[0] ?? {};
          return {
            candidatesJson: [
              {
                url: firstItem.url,
                title: firstItem.title,
                confidence: 0.8,
              },
            ],
          };
        },
      },
    });

    await expect(
      runner.runStructuredTask({
        taskType: 'source_discovery',
        instructions: 'find resource sources',
        input: {
          toolRequests: {
            search: [{ query: 'state Resource portal', limit: 1 }],
            fetch: [{ url: 'https://example.gov/Resources' }],
            crawl: [{ url: 'https://example.gov/Resources' }],
          },
        },
        correlationId: 'source-discovery',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        candidatesJson: [
          {
            url: 'https://example.gov/Resources',
            title: 'Resource portal',
            confidence: 0.8,
          },
        ],
        toolContext: {
          search: [
            {
              query: 'state Resource portal',
              provider: 'firecrawl-search',
              items: [
                {
                  url: 'https://example.gov/Resources',
                  title: 'Resource portal',
                },
              ],
            },
          ],
          fetch: [
            {
              requestedUrl: 'https://example.gov/Resources',
              toolFailure: true,
              error: 'This operation was aborted',
            },
          ],
          crawl: [
            {
              requestedUrl: 'https://example.gov/Resources',
              toolFailure: true,
              error: 'This operation was aborted',
            },
          ],
        },
      },
    });
  });

  it('runs generic agent tasks through tool calls until final output', async () => {
    const calls: unknown[] = [];
    const stepEvents: unknown[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          calls.push(input);
          if (calls.length === 1) {
            return {
              action: 'call_tool',
              toolName: 'set_value',
              input: { value: 'ready' },
              auditNote: 'Recording the value observed from the tool.',
              whyThisStep: 'The task is incomplete until the value is stored.',
              expectedOutcome: 'The setter returns a completed observation.',
              nextIfFails: 'Retry with the corrected setter payload.',
            };
          }
          return {
            action: 'final',
            output: { status: 'done', value: 'ready' },
            auditNote: 'The required value is now available.',
          };
        },
      },
    });

    await expect(
      runner.runAgentTask?.({
        taskType: 'generic.test',
        instructions: 'Use tools until done.',
        input: {},
        tools: [
          {
            name: 'set_value',
            execute: (input) => ({ status: 'completed', value: input.value }),
          },
        ],
        correlationId: 'agent-loop-test',
        maxSteps: 4,
        onStep: (step) => stepEvents.push(step),
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        value: 'ready',
      },
      steps: [
        { actionType: 'call_tool', toolName: 'set_value', status: 'completed' },
        { actionType: 'final', status: 'completed' },
      ],
    });
    expect(stepEvents).toHaveLength(2);
    expect(stepEvents[0]).toMatchObject({
      actionType: 'call_tool',
      actionInput: { value: 'ready' },
      auditNote: 'Recording the value observed from the tool.',
      whyThisStep: 'The task is incomplete until the value is stored.',
      expectedOutcome: 'The setter returns a completed observation.',
      nextIfFails: 'Retry with the corrected setter payload.',
      promptMetrics: expect.objectContaining({
        availableToolCount: 1,
        retainedObservationCount: 0,
      }),
    });
    expect(stepEvents[1]).toMatchObject({
      actionType: 'final',
      auditNote: 'The required value is now available.',
      promptMetrics: expect.objectContaining({
        retainedObservationCount: 1,
      }),
    });
  });

  it('keeps recovery guidance in the generic agent loop after repeated tool failures', async () => {
    const modelStates: unknown[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          modelStates.push(input.input);
          if (modelStates.length <= 2) {
            return {
              action: 'call_tool',
              toolName: 'set_value',
              input: { value: '' },
              auditNote: 'Trying to set the required value.',
            };
          }
          return {
            action: 'final',
            output: {
              status: 'needs_review',
              reason: 'tool did not accept empty value',
            },
          };
        },
      },
    });

    await expect(
      runner.runAgentTask?.({
        taskType: 'generic.recovery',
        instructions: 'Use tools until done.',
        input: {},
        tools: [
          {
            name: 'set_value',
            execute: () => ({ status: 'failed', error: 'value_required' }),
          },
        ],
        correlationId: 'agent-loop-recovery-test',
        maxSteps: 3,
      }),
    ).resolves.toMatchObject({
      status: 'needs_review',
      steps: [
        { actionType: 'call_tool', toolName: 'set_value', status: 'completed' },
        { actionType: 'call_tool', toolName: 'set_value', status: 'completed' },
        { actionType: 'final', status: 'completed' },
      ],
    });

    expect(modelStates[2]).toMatchObject({
      state: expect.objectContaining({
        recoveryHint: expect.objectContaining({
          repeatCount: 2,
          toolName: 'set_value',
          error: 'value_required',
        }),
      }),
    });
  });
});

function cryptoSign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}
