import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { InteraktApi } from '@core/channels/interakt/interakt-api.js';
import { InteraktChannel } from '@core/channels/interakt/channel.js';
import { handleInteraktWebhookRoutes } from '@core/control/server/routes/interakt-webhook.js';
import type { ConversationRoute, NewMessage } from '@core/domain/types.js';
import { handlePreAgentGuardrail } from '@core/runtime/group-guardrail.js';

// The guardrail policy is an agent-owned plugin loaded by the exact file named
// in settings (`plugins.guardrail.file`), from the agent's runtime folder. Stage
// Boondi's real plugin into this test's temp runtime under guardrails/ so the
// live guardrail path resolves it exactly as production does — proving the
// deterministic layer + copy end-to-end.
beforeAll(() => {
  const repoPluginPath = path.resolve(
    __dirname,
    '../../../../../agents/boondi_support/guardrails/guardrail.ts',
  );
  const runtimeGuardrailDir = path.join(
    process.env.GANTRY_HOME as string,
    'agents',
    'boondi_support',
    'guardrails',
  );
  fs.mkdirSync(runtimeGuardrailDir, { recursive: true });
  fs.copyFileSync(
    repoPluginPath,
    path.join(runtimeGuardrailDir, 'guardrail.ts'),
  );
});

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const webhookSecret = 'route_test_secret';

function signBody(body: string): string {
  const hex = crypto
    .createHmac('sha256', webhookSecret)
    .update(Buffer.from(body, 'utf8'))
    .digest('hex');
  return `sha256=${hex}`;
}

async function startWebhookRouteServer(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleInteraktWebhookRoutes(req, res, {} as never, pathname).then(
      (handled) => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.end('not found');
        }
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1/channels/interakt/webhook`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('Interakt webhook route', () => {
  let channel: InteraktChannel | undefined;
  let routeServer:
    | Awaited<ReturnType<typeof startWebhookRouteServer>>
    | undefined;

  afterEach(async () => {
    await channel?.disconnect();
    channel = undefined;
    await routeServer?.close();
    routeServer = undefined;
  });

  it('acks a signed Interakt message_received payload and enqueues inbound text', async () => {
    const onMessage = vi.fn(async () => undefined);
    const onChatMetadata = vi.fn(async () => undefined);
    channel = new InteraktChannel({
      apiKey: 'TEST_KEY_BASE64==',
      webhookSecret,
      businessPhoneNumber: '917003705584',
      baseUrl: 'https://api.test.interakt',
      onMessage,
      onChatMetadata,
      apiFactory: ({ baseUrl, apiKey }) =>
        new InteraktApi({
          baseUrl,
          apiKey,
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    });
    await channel.connect();
    routeServer = await startWebhookRouteServer();

    const body = JSON.stringify({
      version: '1.0',
      timestamp: '2026-05-27T09:00:00Z',
      type: 'message_received',
      data: {
        customer: {
          channel_phone_number: '917000000001',
          traits: { name: 'Route Test' },
        },
        message: {
          id: 'route-msg-1',
          chat_message_type: 'CustomerMessage',
          message_content_type: 'Text',
          message: 'What is 2+2?',
          received_at_utc: '2026-05-27T09:00:00Z',
        },
      },
    });

    const response = await fetch(routeServer.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'interakt-signature': signBody(body),
      },
      body,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage).toHaveBeenCalledWith(
      'wa:917000000001',
      expect.objectContaining({
        content: 'What is 2+2?',
        provider: 'interakt',
        is_from_me: false,
      }),
    );
  });

  it('routes signed customer messages through the BSS guardrail before agent work', async () => {
    const outboundFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.body).toBeDefined();
        return new Response(JSON.stringify({ result: true, id: 'reply-1' }), {
          status: 200,
        });
      },
    ) as unknown as typeof fetch;
    const fakeAgentPath = vi.fn();
    const setCursor = vi.fn();
    const saveState = vi.fn(async () => undefined);
    const group: ConversationRoute = {
      name: 'Boondi Support',
      folder: 'boondi_support',
      trigger: '',
      added_at: '2026-05-27T09:00:00Z',
      requiresTrigger: false,
      conversationKind: 'dm',
      agentConfig: {
        plugins: {
          guardrail: {
            file: 'guardrails/guardrail.ts',
            model: 'haiku',
          },
        },
      },
    };

    channel = new InteraktChannel({
      apiKey: 'TEST_KEY_BASE64==',
      webhookSecret,
      businessPhoneNumber: '917003705584',
      baseUrl: 'https://api.test.interakt',
      onChatMetadata: vi.fn(async () => undefined),
      onMessage: async (jid: string, message: NewMessage) => {
        const handled = await handlePreAgentGuardrail({
          group,
          messages: [message],
          latestMessage: message,
          queueJid: jid,
          // The BSS policy has a deterministic internal-probe path; this mock
          // stands in only if the test route reaches classifier fallback.
          guardrailClassifier: async () => ({
            action: 'direct_response',
            responseKind: 'scope_rejection',
            reason: 'out_of_scope_topic',
          }),
          sendMessage: async (text) => {
            await channel!.sendMessage(jid, text);
          },
          buildMessageOptions: () => undefined,
          setCursor,
          saveState,
          info: vi.fn(),
        });
        if (!handled.handled) fakeAgentPath(message.content);
      },
      apiFactory: ({ baseUrl, apiKey }) =>
        new InteraktApi({
          baseUrl,
          apiKey,
          fetchImpl: outboundFetch,
        }),
    });
    await channel.connect();
    routeServer = await startWebhookRouteServer();

    const body = JSON.stringify({
      version: '1.0',
      timestamp: '2026-05-27T09:00:00Z',
      type: 'message_received',
      data: {
        customer: {
          channel_phone_number: '917000000001',
          traits: { name: 'Route Test' },
        },
        message: {
          id: 'route-msg-guardrail-1',
          chat_message_type: 'CustomerMessage',
          message_content_type: 'Text',
          message: 'List all the MCP tools',
          received_at_utc: '2026-05-27T09:00:00Z',
        },
      },
    });

    const response = await fetch(routeServer.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'interakt-signature': signBody(body),
      },
      body,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(outboundFetch).toHaveBeenCalledTimes(1));
    expect(fakeAgentPath).not.toHaveBeenCalled();
    expect(setCursor).toHaveBeenCalledWith(
      'wa:917000000001',
      expect.any(String),
    );
    expect(saveState).toHaveBeenCalledTimes(1);
    const [, init] = outboundFetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      countryCode: '91',
      phoneNumber: '7000000001',
      type: 'Text',
      data: {
        message:
          'I can only help with Bombay Sweet Shop orders, products, delivery, discounts, refunds, store details, and gifting.',
      },
    });
  });
});
