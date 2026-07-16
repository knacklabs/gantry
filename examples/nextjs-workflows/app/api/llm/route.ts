import { getOpenAIClient, requiredEnv } from '../../../lib/gantry';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    text?: unknown;
  } | null;
  if (typeof body?.text !== 'string' || !body.text.trim()) {
    return Response.json({ error: 'text is required' }, { status: 400 });
  }

  const completion = await getOpenAIClient().chat.completions.create({
    model: requiredEnv('GANTRY_DEMO_MODEL_ALIAS'),
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `Classify this support message as billing, bug, account, or other and explain briefly:\n${body.text.trim()}`,
      },
    ],
  });

  return Response.json({
    text: completion.choices[0]?.message.content ?? '',
    usage: completion.usage,
  });
}
