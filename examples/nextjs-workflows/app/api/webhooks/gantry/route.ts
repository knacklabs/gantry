import { verifyWebhookSignature } from '@gantry/sdk';

export const runtime = 'nodejs';

const REQUIRED_HEADERS = {
  eventId: 'x-gantry-webhook-id',
  timestamp: 'x-gantry-webhook-timestamp',
  eventType: 'x-gantry-webhook-event',
  signature: 'x-gantry-webhook-signature',
} as const;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.GANTRY_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { ok: false, error: 'GANTRY_WEBHOOK_SECRET is not configured' },
      { status: 500 },
    );
  }

  const eventId = request.headers.get(REQUIRED_HEADERS.eventId);
  const timestamp = request.headers.get(REQUIRED_HEADERS.timestamp);
  const eventType = request.headers.get(REQUIRED_HEADERS.eventType);
  const signature = request.headers.get(REQUIRED_HEADERS.signature);

  if (!eventId || !timestamp || !eventType || !signature) {
    return Response.json(
      { ok: false, error: 'missing required Gantry webhook headers' },
      { status: 400 },
    );
  }

  const rawBody = await request.text();
  const verified = verifyWebhookSignature({
    secret,
    timestamp,
    eventId,
    eventType,
    signature,
    rawBody,
  });

  if (!verified) {
    return Response.json(
      { ok: false, error: 'invalid webhook signature' },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json(
      { ok: false, error: 'invalid webhook JSON' },
      { status: 400 },
    );
  }

  // Gantry delivers at least once. This demo performs no side effects and does
  // not claim durable deduplication; production receivers should persist and
  // deduplicate eventId before applying side effects.
  switch (eventType) {
    case 'run.completed':
      return Response.json({
        ok: true,
        eventId,
        eventType,
        acknowledged: 'run completion received',
        payload,
      });
    case 'interaction.pending':
      return Response.json({
        ok: true,
        eventId,
        eventType,
        acknowledged: 'pending interaction received',
        payload,
      });
    default:
      return Response.json({ ok: true, eventId, eventType, ignored: true });
  }
}
