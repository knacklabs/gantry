import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeEventExchange } from '../../../adapters/storage/postgres/runtime-store.js';
import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventId,
} from '../../../domain/events/events.js';
import type { AppId } from '../../../domain/app/app.js';
import { isRuntimeEventType } from '../../../domain/events/runtime-event-types.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';

export async function handleRuntimeEventRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/v1/runtime-events' || req.method !== 'GET') return false;
  const auth = authorizeControlRequest(req, res, ctx.keys, [
    'sessions:read',
    'jobs:read',
  ]);
  if (!auth) return true;

  const filter = parseRuntimeEventFilter(url, auth.appId as AppId);
  if (typeof filter === 'string') {
    sendError(res, 400, 'INVALID_REQUEST', filter);
    return true;
  }
  const exchange = getRuntimeEventExchange();
  const initial = await exchange.list(filter);
  if (!req.headers.accept?.includes('text/event-stream')) {
    sendJson(res, 200, { events: initial.map(serializeRuntimeEvent) });
    return true;
  }
  if (ctx.state.activeStreams >= ctx.maxConcurrentStreams) {
    sendError(res, 429, 'TOO_MANY_STREAMS', 'Too many active event streams');
    return true;
  }

  let closed = req.destroyed || res.destroyed;
  let active = false;
  const cursor = initial.at(-1)?.eventId ?? filter.afterEventId;
  const subscription = exchange.subscribe({ ...filter, afterEventId: cursor });
  const cleanup = () => {
    if (closed && !active) return;
    closed = true;
    subscription.close();
    if (active) {
      active = false;
      ctx.state.activeStreams = Math.max(0, ctx.state.activeStreams - 1);
    }
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
  if (closed) {
    cleanup();
    return true;
  }

  ctx.state.activeStreams += 1;
  active = true;
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  for (const event of initial) await writeEvent(res, event, () => closed);

  void (async () => {
    while (!closed) {
      try {
        const next = await subscription.next({ timeoutMs: 30_000 });
        if (next.length === 0) {
          await writeChunk(res, ': heartbeat\n\n', () => closed);
          continue;
        }
        for (const event of next) await writeEvent(res, event, () => closed);
      } catch (error) {
        if (closed) return;
        logger.warn({ err: error }, 'Failed streaming app runtime events');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  })();
  return true;
}

export function parseRuntimeEventFilter(
  url: URL,
  appId: AppId,
): RuntimeEventFilter | string {
  const afterStreamPosition = url.searchParams.get('afterStreamPosition');
  const afterEventId = Number(
    afterStreamPosition ?? url.searchParams.get('afterEventId') ?? '0',
  );
  const limit = Number(url.searchParams.get('limit') ?? '100');
  if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
    return 'afterStreamPosition/afterEventId must be a non-negative integer';
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    return 'limit must be an integer between 1 and 500';
  }
  const eventTypes = url.searchParams
    .getAll('eventType')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (eventTypes.some((eventType) => !isRuntimeEventType(eventType))) {
    return 'eventType contains an unknown runtime event type';
  }
  return {
    appId,
    afterEventId: afterEventId as RuntimeEventId,
    limit,
    ...(url.searchParams.get('sessionId')
      ? { sessionId: url.searchParams.get('sessionId') as never }
      : {}),
    ...(url.searchParams.get('jobId')
      ? { jobId: url.searchParams.get('jobId') as never }
      : {}),
    ...(url.searchParams.get('runId')
      ? { runId: url.searchParams.get('runId') as never }
      : {}),
    ...(eventTypes.length > 0
      ? { eventTypes: eventTypes.filter(isRuntimeEventType) }
      : {}),
  };
}

function serializeRuntimeEvent(event: RuntimeEvent) {
  return {
    eventId: event.eventId,
    streamPosition: event.eventId,
    eventType: event.eventType,
    sessionId: event.sessionId ?? null,
    jobId: event.jobId ?? null,
    runId: event.runId ?? null,
    triggerId: event.triggerId ?? null,
    conversationId: event.conversationId ?? null,
    threadId: event.threadId ?? null,
    correlationId: event.correlationId ?? null,
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

async function writeEvent(
  res: ServerResponse,
  event: RuntimeEvent,
  isClosed: () => boolean,
): Promise<void> {
  await writeChunk(
    res,
    `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(serializeRuntimeEvent(event))}\n\n`,
    isClosed,
  );
}

async function writeChunk(
  res: ServerResponse,
  chunk: string,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed() || res.destroyed || res.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      res.off('drain', finish);
      res.off('close', finish);
      res.off('error', finish);
      resolve();
    };
    res.once('drain', finish);
    res.once('close', finish);
    res.once('error', finish);
  });
}
