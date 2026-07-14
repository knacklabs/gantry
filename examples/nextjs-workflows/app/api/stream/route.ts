import { getGantryClient } from '../../../lib/gantry';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('sessionId')?.trim();
  const afterEventId = Number(url.searchParams.get('afterEventId') || 0);
  if (!sessionId || !Number.isSafeInteger(afterEventId) || afterEventId < 0) {
    return Response.json(
      { error: 'sessionId and a non-negative afterEventId are required' },
      { status: 400 },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of getGantryClient().sessions.stream(sessionId, {
          afterEventId,
          signal: request.signal,
        })) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
