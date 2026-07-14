import { getGantryClient, requiredEnv } from '../../../lib/gantry';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    message?: unknown;
  } | null;
  if (typeof body?.message !== 'string' || !body.message.trim()) {
    return Response.json({ error: 'message is required' }, { status: 400 });
  }

  const client = getGantryClient();
  const session = await client.sessions.ensure({
    conversationId: requiredEnv('GANTRY_DEMO_CONVERSATION_ID'),
    title: 'Next.js workflows demo',
    responseMode: 'sse',
  });
  const accepted = await client.sessions.sendMessage({
    sessionId: session.sessionId,
    message: body.message.trim(),
    senderId: 'nextjs-workflows-demo',
    senderName: 'Next.js workflows demo',
  });
  const result = await client.sessions.wait(session.sessionId, {
    afterEventId: accepted.acceptedEventId,
    timeoutMs: 120_000,
  });

  return Response.json({ session, accepted, result });
}
