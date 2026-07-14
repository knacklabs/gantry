import http from 'node:http';
import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  conversationMessageTarget,
  GantryClient,
  signIngressRequest,
  verifyIngressSignature,
  verifyWebhookSignature,
} from '../../../../../packages/sdk/src/index.js';

let server: http.Server | null = null;

function listen(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not bind SDK test server'));
        return;
      }
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  const existing = server;
  server = null;
  if (!existing) return;
  await new Promise<void>((resolve, reject) => {
    existing.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('@gantry/sdk webhook verification', () => {
  it('rejects stale signatures by default', () => {
    const timestamp = String(Date.now() - 10 * 60_000);
    const eventId = 'event-1';
    const eventType = 'session.message.outbound';
    const rawBody = JSON.stringify({ ok: true });
    const signature = createHmac('sha256', 'secret')
      .update(`${timestamp}.${eventId}.${eventType}.${rawBody}`)
      .digest('hex');

    expect(
      verifyWebhookSignature({
        secret: 'secret',
        timestamp,
        eventId,
        eventType,
        rawBody,
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });
});

describe('@gantry/sdk ingress signature verification', () => {
  it('accepts a valid ingress signature', () => {
    const timestamp = String(Date.now());
    const signature = signIngressRequest({
      secret: 'secret',
      method: 'post',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: JSON.stringify({ ok: true }),
    });

    expect(
      verifyIngressSignature({
        secret: 'secret',
        method: 'POST',
        path: '/v1/external-ingress/invoke',
        timestamp,
        nonce: 'nonce-1',
        rawBody: JSON.stringify({ ok: true }),
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(true);
  });

  it('rejects stale ingress signatures by default', () => {
    const timestamp = String(Date.now() - 10 * 60_000);
    const signature = signIngressRequest({
      secret: 'secret',
      method: 'POST',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: '{}',
    });

    expect(
      verifyIngressSignature({
        secret: 'secret',
        method: 'POST',
        path: '/v1/external-ingress/invoke',
        timestamp,
        nonce: 'nonce-1',
        rawBody: '{}',
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });

  it('rejects tampered ingress payloads', () => {
    const timestamp = String(Date.now());
    const signature = signIngressRequest({
      secret: 'secret',
      method: 'POST',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: JSON.stringify({ ok: true }),
    });

    expect(
      verifyIngressSignature({
        secret: 'secret',
        method: 'POST',
        path: '/v1/external-ingress/invoke',
        timestamp,
        nonce: 'nonce-1',
        rawBody: JSON.stringify({ ok: false }),
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });

  it('builds typed conversation_message ingress targets', () => {
    expect(
      conversationMessageTarget({
        conversationId: 'conversation:ops-room',
        agentId: 'agent:ops',
        threadId: 'thread:ops-room:daily',
        message: 'Run the test',
        senderId: 'external-ci',
        senderName: 'External CI',
      }),
    ).toEqual({
      kind: 'conversation_message',
      conversationId: 'conversation:ops-room',
      agentId: 'agent:ops',
      threadId: 'thread:ops-room:daily',
      message: 'Run the test',
      senderId: 'external-ci',
      senderName: 'External CI',
    });
  });
});

describe('@gantry/sdk transport', () => {
  it('does not send an undefined content-type header for GET requests', async () => {
    const port = await listen((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer test-key');
      expect(req.headers['content-type']).toBeUndefined();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    const client = new GantryClient({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await expect(client.health()).resolves.toEqual({ status: 'ok' });
  });

  it('sends JSON content-type for POST requests with a body', async () => {
    const port = await listen((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessionId: 'session-1' }));
    });
    const client = new GantryClient({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await expect(
      client.sessions.ensure({
        appId: 'app-one',
        conversationId: 'conv-one',
      }),
    ).resolves.toEqual({ sessionId: 'session-1' });
  });

  it('builds the usage query from every typed filter', async () => {
    const client = new GantryClient({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:3939',
    });
    const request = vi
      .spyOn(
        (client as unknown as { transport: { request: () => unknown } })
          .transport,
        'request',
      )
      .mockResolvedValue({ usage: [] });

    await expect(
      client.usage.query({
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-02T00:00:00.000Z',
        agentId: 'agent/1',
        apiKeyId: 'key/1',
        runId: 'run/1',
        jobId: 'job/1',
        model: 'opus/4',
        group_by: 'api_key',
      }),
    ).resolves.toEqual({ usage: [] });
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/usage?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-02T00%3A00%3A00.000Z&agentId=agent%2F1&apiKeyId=key%2F1&runId=run%2F1&jobId=job%2F1&model=opus%2F4&group_by=api_key',
    });
  });

  it('builds ingress management requests', async () => {
    const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        seen.push({
          method: req.method,
          url: req.url,
          body: raw ? JSON.parse(raw) : null,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ingresses: [] }));
      });
    });
    const client = new GantryClient({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await client.ingresses.create({
      name: 'Primary ingress',
      enabled: true,
      metadata: { team: 'ops' },
    });
    await client.ingresses.list();
    await client.ingresses.get('ingress/1');
    await client.ingresses.update('ingress/1', {
      name: 'Renamed ingress',
      enabled: false,
    });
    await client.ingresses.rotate('ingress/1');
    await client.ingresses.delete('ingress/1');

    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/ingresses',
        body: {
          name: 'Primary ingress',
          enabled: true,
          metadata: { team: 'ops' },
        },
      },
      {
        method: 'GET',
        url: '/v1/ingresses',
        body: null,
      },
      {
        method: 'GET',
        url: '/v1/ingresses/ingress%2F1',
        body: null,
      },
      {
        method: 'PATCH',
        url: '/v1/ingresses/ingress%2F1',
        body: {
          name: 'Renamed ingress',
          enabled: false,
        },
      },
      {
        method: 'POST',
        url: '/v1/ingresses/ingress%2F1/rotate',
        body: null,
      },
      {
        method: 'DELETE',
        url: '/v1/ingresses/ingress%2F1',
        body: null,
      },
    ]);
  });

  it('builds every channel onboarding and binding request', async () => {
    const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const raw = body.toString('utf8');
        seen.push({
          method: req.method,
          url: req.url,
          body:
            req.headers['content-type'] === 'application/zip'
              ? [...body]
              : raw
                ? JSON.parse(raw)
                : null,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            conversations: [],
            conversationInstalls: [],
          }),
        );
      });
    });
    const client = new GantryClient({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await client.settings.get();
    await client.providers.list();
    await client.providerAccounts.create({
      appId: 'app-one',
      agentId: 'agent/1',
      providerId: 'slack',
      label: 'Slack',
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
    });
    await client.providerAccounts.list();
    await client.providerAccounts.get('providerAccount/1');
    await client.providerAccounts.update('providerAccount/1', {
      label: 'Slack workspace',
      enabled: false,
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN_V2' },
    });
    await client.providerAccounts.delete('providerAccount/1');
    await client.providerAccounts.discoverConversations('providerAccount/1', {
      limit: 10,
    });
    await client.conversations.list({
      providerAccountId: 'providerAccount/1',
    });
    await client.conversations.get('conversation/1');
    await client.conversations.messages('conversation/1', {
      threadId: 'thread/1',
      after: 'message/0',
      limit: 5,
    });
    await client.agents.conversationInstalls.list('agent/1');
    await client.agents.conversationInstalls.enable(
      'agent/1',
      'conversation/1',
      {
        memoryScope: 'conversation',
      },
    );
    await client.agents.conversationInstalls.update(
      'agent/1',
      'conversation/1',
      {
        permissionPolicyIds: ['policy/1'],
      },
    );
    await client.agents.conversationInstalls.disable(
      'agent/1',
      'conversation/1',
      {
        threadId: 'thread/1',
      },
    );
    await client.skills.install({
      agentId: 'agent/1',
      createdBy: 'admin',
      zip: new Uint8Array([1, 2, 3]),
    });
    await client.skills.list({ agentId: 'agent/1' });
    await client.agents.skills.list('agent/1');
    await client.agents.skills.enable('agent/1', 'skill/1');
    await client.agents.skills.disable('agent/1', 'skill/1');

    expect(seen).toEqual([
      { method: 'GET', url: '/v1/settings', body: null },
      { method: 'GET', url: '/v1/providers', body: null },
      {
        method: 'POST',
        url: '/v1/provider-accounts',
        body: {
          appId: 'app-one',
          agentId: 'agent/1',
          providerId: 'slack',
          label: 'Slack',
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
        },
      },
      { method: 'GET', url: '/v1/provider-accounts', body: null },
      {
        method: 'GET',
        url: '/v1/provider-accounts/providerAccount%2F1',
        body: null,
      },
      {
        method: 'PATCH',
        url: '/v1/provider-accounts/providerAccount%2F1',
        body: {
          label: 'Slack workspace',
          enabled: false,
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN_V2' },
        },
      },
      {
        method: 'DELETE',
        url: '/v1/provider-accounts/providerAccount%2F1',
        body: null,
      },
      {
        method: 'POST',
        url: '/v1/provider-accounts/providerAccount%2F1/discover-conversations',
        body: { limit: 10 },
      },
      {
        method: 'GET',
        url: '/v1/conversations?providerAccountId=providerAccount%2F1',
        body: null,
      },
      {
        method: 'GET',
        url: '/v1/conversations/conversation%2F1',
        body: null,
      },
      {
        method: 'GET',
        url: '/v1/conversations/conversation%2F1/messages?threadId=thread%2F1&after=message%2F0&limit=5',
        body: null,
      },
      {
        method: 'GET',
        url: '/v1/agents/agent%2F1/conversation-installs',
        body: null,
      },
      {
        method: 'PUT',
        url: '/v1/agents/agent%2F1/conversation-installs/conversation%2F1',
        body: {
          memoryScope: 'conversation',
        },
      },
      {
        method: 'PATCH',
        url: '/v1/agents/agent%2F1/conversation-installs/conversation%2F1',
        body: {
          permissionPolicyIds: ['policy/1'],
        },
      },
      {
        method: 'DELETE',
        url: '/v1/agents/agent%2F1/conversation-installs/conversation%2F1?threadId=thread%2F1',
        body: null,
      },
      {
        method: 'POST',
        url: '/v1/skills/install?agentId=agent%2F1&createdBy=admin',
        body: [1, 2, 3],
      },
      {
        method: 'GET',
        url: '/v1/skills?agentId=agent%2F1',
        body: null,
      },
      {
        method: 'GET',
        url: '/v1/agents/agent%2F1/skills',
        body: null,
      },
      {
        method: 'PUT',
        url: '/v1/agents/agent%2F1/skills/skill%2F1',
        body: {},
      },
      {
        method: 'DELETE',
        url: '/v1/agents/agent%2F1/skills/skill%2F1',
        body: null,
      },
    ]);
  });
});
