import { getGantryClient, requiredEnv } from '../../../lib/gantry';

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['category', 'priority', 'summary'],
  properties: {
    category: {
      type: 'string',
      enum: ['billing', 'bug', 'account', 'other'],
    },
    priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
    summary: { type: 'string' },
  },
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    ticketText?: unknown;
  } | null;
  if (typeof body?.ticketText !== 'string' || !body.ticketText.trim()) {
    return Response.json({ error: 'ticketText is required' }, { status: 400 });
  }

  const client = getGantryClient();
  const session = await client.sessions.ensure({
    conversationId: requiredEnv('GANTRY_DEMO_CONVERSATION_ID'),
    title: 'Next.js workflows demo',
    responseMode: 'sse',
  });
  const accepted = await client.sessions.sendMessage({
    sessionId: session.sessionId,
    message: `Triage this support ticket:\n${body.ticketText.trim()}`,
    senderId: 'nextjs-workflows-demo',
    senderName: 'Next.js workflows demo',
    response_schema: TRIAGE_SCHEMA as never,
    effort: 'low',
  });
  const event = await client.sessions.wait(session.sessionId, {
    afterEventId: accepted.acceptedEventId,
    timeoutMs: 60_000,
  });
  const payload = event.payload as { text?: unknown };
  if (typeof payload.text !== 'string') {
    throw new Error('Gantry returned a workflow event without text');
  }

  return Response.json(JSON.parse(payload.text));
}
