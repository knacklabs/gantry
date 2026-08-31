import http from 'node:http';
import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  conversationMessageTarget,
  GantryClient,
  SessionTypingTracker,
  signIngressRequestEd25519,
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
        privateKeyPem: 'dummy-private-key',
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
    const signature = signIngressRequestEd25519({
      privateKeyPem: 'dummy-private-key',
      method: 'post',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: JSON.stringify({ ok: true }),
    });

    expect(
      verifyIngressSignature({
        privateKeyPem: 'dummy-private-key',
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
    const signature = signIngressRequestEd25519({
      privateKeyPem: 'dummy-private-key',
      method: 'POST',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: '{}',
    });

    expect(
      verifyIngressSignature({
        privateKeyPem: 'dummy-private-key',
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
    const signature = signIngressRequestEd25519({
      privateKeyPem: 'dummy-private-key',
      method: 'POST',
      path: '/v1/external-ingress/invoke',
      timestamp,
      nonce: 'nonce-1',
      rawBody: JSON.stringify({ ok: true }),
    });

    expect(
      verifyIngressSignature({
        privateKeyPem: 'dummy-private-key',
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

  it('returns raw list events with their original sequence', async () => {
    const client = new GantryClient({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:3939',
    });
    const event = (
      sequence: number,
      isTyping: boolean,
      eventId: number,
      threadId: string,
    ) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping,
        orderedEnvelope: {
          generation: 1,
          sequence,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const request = vi
      .spyOn(
        (client as unknown as { transport: { request: () => unknown } })
          .transport,
        'request',
      )
      .mockResolvedValueOnce({
        events: [
          event(2, false, 1, 'thread-a'),
          event(1, true, 2, 'thread-b'),
          event(1, true, 3, 'thread-a'),
        ],
      })
      .mockResolvedValueOnce({ events: [event(1, true, 3, 'thread-a')] });

    await expect(client.sessions.listEvents('session-1')).resolves.toEqual({
      events: [
        event(2, false, 1, 'thread-a'),
        event(1, true, 2, 'thread-b'),
        event(1, true, 3, 'thread-a'),
      ],
    });
    await expect(client.sessions.listEvents('session-1', 2)).resolves.toEqual({
      events: [event(1, true, 3, 'thread-a')],
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps latest typing off across two raw wait polls with a caller-owned tracker', async () => {
    const client = new GantryClient({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:3939',
    });
    const event = (sequence: number, isTyping: boolean, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId: null,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping,
        orderedEnvelope: {
          generation: 1,
          sequence,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
      afterEventId: eventId,
    });
    const request = vi
      .spyOn(
        (client as unknown as { transport: { request: () => unknown } })
          .transport,
        'request',
      )
      .mockResolvedValueOnce(event(2, false, 1))
      .mockResolvedValueOnce(event(1, true, 2));

    const tracker = client.sessions.createTypingTracker();
    const terminal = await client.sessions.wait('session-1', {
      timeoutMs: 5_000,
    });
    const lateStart = await client.sessions.wait('session-1', {
      afterEventId: 1,
      timeoutMs: 5_000,
    });

    expect(tracker.apply(terminal)).toBe(true);
    expect(tracker.apply(lateStart)).toBe(false);
    expect(tracker.isTyping('session-1')).toBe(false);
    tracker.dispose();
    expect(request.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        path: expect.stringContaining('afterEventId=1'),
      }),
    );
  });

  it('yields durable typing events without an implicit tracker', async () => {
    const event = (sequence: number, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId: 'thread-1',
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping: sequence === 1,
        orderedEnvelope: {
          generation: 1,
          sequence,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const client = new GantryClient({ apiKey: 'one' });
    vi.spyOn(
      (
        client as unknown as {
          transport: { stream: () => AsyncIterable<unknown> };
        }
      ).transport,
      'stream',
    ).mockImplementation(async function* () {
      yield event(2, 1);
      yield event(1, 2);
    });

    const collect = async () => {
      const events = [];
      for await (const streamed of client.sessions.stream('session-1')) {
        events.push(streamed);
      }
      return events;
    };

    await expect(collect()).resolves.toEqual([event(2, 1), event(1, 2)]);
    await expect(collect()).resolves.toEqual([event(2, 1), event(1, 2)]);
  });

  it('yields durable reconnect events while the tracker keeps current state', async () => {
    const event = (sequence: number, isTyping: boolean, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId: 'thread-1',
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping,
        orderedEnvelope: {
          generation: 1,
          sequence,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const client = new GantryClient({ apiKey: 'one' });
    const stream = vi.spyOn(
      (
        client as unknown as {
          transport: { stream: () => AsyncIterable<unknown> };
        }
      ).transport,
      'stream',
    );
    stream
      .mockImplementationOnce(async function* () {
        yield event(2, false, 2);
      })
      .mockImplementationOnce(async function* () {
        yield event(1, true, 3);
      });
    const tracker = client.sessions.createTypingTracker();
    const collect = async (afterEventId: number) => {
      const events = [];
      for await (const streamed of client.sessions.stream('session-1', {
        afterEventId,
        tracker,
      })) {
        events.push(streamed);
      }
      return events;
    };

    await expect(collect(1)).resolves.toEqual([event(2, false, 2)]);
    await expect(collect(2)).resolves.toEqual([event(1, true, 3)]);
    expect(tracker.isTyping('session-1', 'thread-1')).toBe(false);
    expect(stream.mock.calls[1]?.[0]).toContain('afterEventId=2');
    tracker.dispose();
  });

  it('yields only durable events while the tracker exposes generation invalidation', async () => {
    const event = (threadId: string, generation: number, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping: true,
        orderedEnvelope: {
          generation,
          sequence: 1,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const threadBStart = event('thread-b', 1, 1);
    const threadANewerProducer = event('thread-a', 2, 2);
    const client = new GantryClient({ apiKey: 'one' });
    vi.spyOn(
      (
        client as unknown as {
          transport: { stream: () => AsyncIterable<unknown> };
        }
      ).transport,
      'stream',
    ).mockImplementation(async function* () {
      yield threadBStart;
      yield threadANewerProducer;
    });

    const tracker = client.sessions.createTypingTracker();
    const streamed = [];
    for await (const event of client.sessions.stream('session-1', {
      tracker,
    })) {
      streamed.push(event);
    }

    expect(streamed).toEqual([threadBStart, threadANewerProducer]);
    expect(tracker.isTyping('session-1', 'thread-b')).toBe(false);
    expect(tracker.takeInvalidatedTypingTargets()).toEqual([
      { sessionId: 'session-1', threadId: 'thread-b' },
    ]);
  });

  it("keeps a shared tracker's generation invalidation on its originating session stream", async () => {
    const typing = (
      sessionId: string,
      threadId: string,
      generation: number,
      eventId: number,
    ) => ({
      eventId,
      eventType: 'session.typing',
      sessionId,
      threadId,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping: true,
        orderedEnvelope: {
          generation,
          sequence: 1,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const sessionANewerProducer = typing('session-a', 'thread-a', 2, 2);
    const sessionBEvent = {
      eventId: 1,
      eventType: 'session.message.outbound',
      sessionId: 'session-b',
      threadId: null,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: { text: 'session B only' },
    };
    const client = new GantryClient({ apiKey: 'one' });
    vi.spyOn(
      (
        client as unknown as {
          transport: { stream: (pathname: string) => AsyncIterable<unknown> };
        }
      ).transport,
      'stream',
    ).mockImplementation(async function* (pathname: string) {
      if (pathname.includes('session-a')) yield sessionANewerProducer;
      else yield sessionBEvent;
    });
    const tracker = client.sessions.createTypingTracker();
    tracker.apply(typing('session-a', 'thread-b', 1, 1));
    const sessionAStream = client.sessions.stream('session-a', { tracker });
    const sessionBStream = client.sessions.stream('session-b', { tracker });
    const streamA = sessionAStream[Symbol.asyncIterator]();
    const streamB = sessionBStream[Symbol.asyncIterator]();

    await expect(streamA.next()).resolves.toEqual({
      done: false,
      value: sessionANewerProducer,
    });
    expect(tracker.takeInvalidatedTypingTargets()).toEqual([
      { sessionId: 'session-a', threadId: 'thread-b' },
    ]);
    await expect(streamB.next()).resolves.toEqual({
      done: false,
      value: sessionBEvent,
    });
    await expect(streamB.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(streamA.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    tracker.dispose();
  });

  it('reconnects from the caller cursor without losing or replaying durable events', async () => {
    const event = (threadId: string, generation: number, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping: true,
        orderedEnvelope: {
          generation,
          sequence: 1,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const threadBStart = event('thread-b', 1, 1);
    const triggeringDurableEvent = event('thread-a', 2, 2);
    const client = new GantryClient({ apiKey: 'one' });
    const stream = vi.spyOn(
      (
        client as unknown as {
          transport: { stream: () => AsyncIterable<unknown> };
        }
      ).transport,
      'stream',
    );
    stream
      .mockImplementationOnce(async function* () {
        yield threadBStart;
      })
      .mockImplementationOnce(async function* () {
        yield triggeringDurableEvent;
      });
    const tracker = client.sessions.createTypingTracker();
    const first = [];
    for await (const streamed of client.sessions.stream('session-1', {
      tracker,
    })) {
      first.push(streamed);
    }

    expect(first).toEqual([threadBStart]);

    const resumed = [];
    for await (const streamed of client.sessions.stream('session-1', {
      afterEventId: 1,
      tracker,
    })) {
      resumed.push(streamed);
    }
    expect(resumed).toEqual([triggeringDurableEvent]);
    expect(stream.mock.calls[1]?.[0]).toContain('afterEventId=1');
    expect(tracker.isTyping('session-1', 'thread-b')).toBe(false);
    expect(tracker.takeInvalidatedTypingTargets()).toEqual([
      { sessionId: 'session-1', threadId: 'thread-b' },
    ]);
    tracker.dispose();
  });

  it('preserves one durable event for each event id without synthetic duplicates', async () => {
    const event = (threadId: string, generation: number, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId,
      payload: {
        isTyping: true,
        orderedEnvelope: {
          generation,
          sequence: 1,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const client = new GantryClient({ apiKey: 'one' });
    vi.spyOn(
      (
        client as unknown as {
          transport: { stream: () => AsyncIterable<unknown> };
        }
      ).transport,
      'stream',
    ).mockImplementation(async function* () {
      yield event('thread-b', 1, 1);
      yield event('thread-a', 2, 2);
    });
    const observed = [];

    for await (const streamed of client.sessions.stream('session-1')) {
      observed.push(streamed);
    }

    expect(observed).toEqual([
      event('thread-b', 1, 1),
      event('thread-a', 2, 2),
    ]);
    expect(new Set(observed.map((event) => event.eventId)).size).toBe(2);
  });

  it('records legacy typing state until an ordered envelope establishes the baseline', () => {
    const tracker = new SessionTypingTracker();
    const legacy = (isTyping: boolean, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId: null,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: { isTyping },
    });
    const ordered = {
      ...legacy(false, 3),
      payload: {
        isTyping: false,
        orderedEnvelope: {
          generation: 1,
          sequence: 2,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    };

    expect(tracker.apply(legacy(true, 1))).toBe(true);
    expect(tracker.isTyping('session-1')).toBe(true);
    expect(tracker.apply(legacy(false, 2))).toBe(true);
    expect(tracker.isTyping('session-1')).toBe(false);
    expect(tracker.apply(ordered)).toBe(true);
    expect(tracker.apply(legacy(true, 4))).toBe(false);
    expect(tracker.isTyping('session-1')).toBe(false);
  });

  it('does not hide suppressed typing events or rewrite the reconnect cursor', async () => {
    const event = (sequence: number, isTyping: boolean, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId: null,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping,
        orderedEnvelope: {
          generation: 1,
          sequence,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const client = new GantryClient({ apiKey: 'one' });
    const stream = vi.spyOn(
      (
        client as unknown as {
          transport: { stream: () => AsyncIterable<unknown> };
        }
      ).transport,
      'stream',
    );
    stream
      .mockImplementationOnce(async function* () {
        yield event(2, false, 2);
        yield event(1, true, 3);
      })
      .mockImplementationOnce(async function* () {});
    const tracker = client.sessions.createTypingTracker();

    const first = [];
    for await (const streamed of client.sessions.stream('session-1', {
      tracker,
    })) {
      first.push(streamed);
    }
    const second = [];
    for await (const streamed of client.sessions.stream('session-1', {
      afterEventId: 2,
      tracker,
    })) {
      second.push(streamed);
    }

    expect(first).toEqual([event(2, false, 2), event(1, true, 3)]);
    expect(second).toEqual([]);
    expect(stream.mock.calls[1]?.[0]).toContain('afterEventId=2');
    expect(tracker.isTyping('session-1')).toBe(false);
  });

  it('keeps tracker typing state independent across sessions', async () => {
    const event = (sessionId: string, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId,
      threadId: null,
      correlationId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      payload: {
        isTyping: true,
        orderedEnvelope: {
          generation: 1,
          sequence: 1,
          kind: 'typing',
          partIndex: 1,
          totalParts: 1,
        },
      },
    });
    const client = new GantryClient({ apiKey: 'one' });
    const stream = vi.spyOn(
      (
        client as unknown as {
          transport: { stream: () => AsyncIterable<unknown> };
        }
      ).transport,
      'stream',
    );
    stream
      .mockImplementationOnce(async function* () {
        yield event('session-a', 100);
      })
      .mockImplementationOnce(async function* () {
        yield event('session-b', 1);
      });
    const tracker = client.sessions.createTypingTracker();

    for await (const _event of client.sessions.stream('session-a', {
      tracker,
    })) {
      // Consume the first session to establish its typing state.
    }
    const sessionB = [];
    for await (const streamed of client.sessions.stream('session-b', {
      tracker,
    })) {
      sessionB.push(streamed);
    }

    expect(stream.mock.calls[1]?.[0]).toBe('/v1/sessions/session-b/events');
    expect(sessionB).toEqual([event('session-b', 1)]);
    expect(tracker.isTyping('session-a')).toBe(true);
    expect(tracker.isTyping('session-b')).toBe(true);
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

  it('builds observer status and paginated insight requests', async () => {
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
      .mockResolvedValue({ insights: [], nextCursor: null });

    await client.observer.status({ appId: 'app/one' });
    await client.observer.insights({
      appId: 'app/one',
      subject: 'msu_44444444444444444444444444444444',
      type: 'commitment',
      state: 'pending',
      limit: 10,
      cursor: 'cursor/one',
    });

    expect(request).toHaveBeenNthCalledWith(1, {
      method: 'GET',
      path: '/v1/observer/status?appId=app%2Fone',
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      path: '/v1/observer/insights?appId=app%2Fone&subject=msu_44444444444444444444444444444444&type=commitment&state=pending&limit=10&cursor=cursor%2Fone',
    });
  });

  it('builds memory-review queue requests', async () => {
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
      .mockResolvedValue({ review: {} });

    await client.memory.reviews.list({
      agentId: 'agent/1',
      subjectType: 'user',
      subjectId: 'user/9',
      limit: 5,
    });
    await client.memory.reviews.get('rev/1', {
      agentId: 'agent/1',
      subjectType: 'user',
      subjectId: 'user/9',
    });
    await client.memory.reviews.decide('rev/1', {
      agentId: 'agent/1',
      subjectType: 'user',
      subjectId: 'user/9',
      decision: 'edit_approve',
      editedValue: 'v2',
      reason: 'why',
    });

    expect(request).toHaveBeenNthCalledWith(1, {
      method: 'GET',
      path: '/v1/memory/reviews?agentId=agent%2F1&subjectType=user&subjectId=user%2F9&limit=5',
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      path: '/v1/memory/reviews/rev%2F1?agentId=agent%2F1&subjectType=user&subjectId=user%2F9',
    });
    // Subject rides on the query; only the decision fields go in the body.
    expect(request).toHaveBeenNthCalledWith(3, {
      method: 'POST',
      path: '/v1/memory/reviews/rev%2F1/decision?agentId=agent%2F1&subjectType=user&subjectId=user%2F9',
      body: { decision: 'edit_approve', editedValue: 'v2', reason: 'why' },
    });

    // Compile-time contract: edit_approve without editedValue is a type error
    // (never executed — checked by tsc). approve without editedValue is fine.
    const _typeCheck = () => {
      // @ts-expect-error editedValue is required for an edit_approve decision.
      client.memory.reviews.decide('rev/1', {
        agentId: 'agent/1',
        subjectType: 'user',
        subjectId: 'user/9',
        decision: 'edit_approve',
      });
      client.memory.reviews.decide('rev/1', {
        agentId: 'agent/1',
        subjectType: 'user',
        subjectId: 'user/9',
        decision: 'approve',
      });
      // approve accepts (server ignores) editedValue — back-compat.
      client.memory.reviews.decide('rev/1', {
        agentId: 'agent/1',
        subjectType: 'user',
        subjectId: 'user/9',
        decision: 'approve',
        editedValue: 'x',
      });
    };
    void _typeCheck;
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
