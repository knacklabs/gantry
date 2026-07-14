# Outbound Webhooks

Gantry outbound webhooks are host-owned callback destinations. Agents do not
choose webhook URLs. They deliver durable runtime events to an application after
Gantry has accepted work.

Do not use `/v1/webhooks` for inbound authority. Signed inbound systems use
external ingress records under `/v1/ingresses`.

## Lifecycle subscriptions

A registration may subscribe to runtime event types, optionally scoped to one
subject:

```ts
client.webhooks.register({
  name: 'run-lifecycle',
  url: 'https://app.example.com/hooks/gantry',
  eventTypes: ['run.completed', 'run.failed', 'interaction.pending'],
  agentId: 'support-agent', // optional; sessionId / jobId also accepted
});
```

Subscribed events are fanned out automatically from the durable runtime event
log (transactional outbox) through the same signed delivery machinery — no
per-request `webhookId` needed. Subject scoping (`agentId`, `sessionId`,
`jobId`) requires `eventTypes`. Registrations without `eventTypes` keep the
original behavior: they deliver only when a session/message names the webhook
explicitly.

`interaction.pending` fires when an agent records a durable pending
interaction (a question or permission prompt awaiting a human) — subscribe to
it to react to "agent is waiting" without polling session events.

Delivery payloads carry top-level `agentId`, `conversationId`, and `threadId`
when present on the event, alongside the existing envelope fields.

## Delivery behavior

- signed with HMAC-SHA256
- at-least-once delivery
- retry on timeout, `408`, `429`, and `5xx`
- dead-letter after bounded retries
- replay and purge APIs for dead letters

## Headers

- `x-gantry-webhook-id`
- `x-gantry-webhook-timestamp`
- `x-gantry-webhook-event`
- `x-gantry-webhook-signature`
- `x-gantry-correlation-id` when present

## Signature verification

```ts
import { verifyWebhookSignature } from '@gantry/sdk';

export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifyWebhookSignature({
    secret: process.env.GANTRY_WEBHOOK_SECRET!,
    timestamp: req.headers.get('x-gantry-webhook-timestamp')!,
    eventId: req.headers.get('x-gantry-webhook-id')!,
    eventType: req.headers.get('x-gantry-webhook-event')!,
    signature: req.headers.get('x-gantry-webhook-signature')!,
    rawBody,
    toleranceMs: 5 * 60_000,
  });

  if (!ok) {
    return new Response('invalid signature', { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  return Response.json({ ok: true, payload });
}
```

## Replay safety

Deduplicate on `x-gantry-webhook-id`. The same event may be delivered more than once. The SDK verifier rejects timestamps outside a 5 minute tolerance by default; keep a durable processed-event table for side effects.
