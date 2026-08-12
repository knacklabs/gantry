import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type {
  ConsoleMetricRange,
  ConsoleMetricsQuery,
} from '../../../domain/events/events.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';

const RANGES: Record<
  ConsoleMetricRange,
  { durationMs: number; bucket: 'hour' | 'day' }
> = {
  '24h': { durationMs: 24 * 60 * 60_000, bucket: 'hour' },
  '7d': { durationMs: 7 * 24 * 60 * 60_000, bucket: 'day' },
  '30d': { durationMs: 30 * 24 * 60 * 60_000, bucket: 'day' },
};

export async function handleMetricsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/v1/metrics' || req.method !== 'GET') return false;

  const auth = authorizeControlRequest(req, res, ctx.keys, ['usage:read']);
  if (!auth) return true;

  const unknown = [...url.searchParams.keys()].find((key) => key !== 'range');
  const requestedRanges = url.searchParams.getAll('range');
  const requestedRange = requestedRanges[0] ?? '24h';
  if (
    unknown ||
    requestedRanges.length > 1 ||
    !Object.hasOwn(RANGES, requestedRange)
  ) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'range must be exactly one of 24h, 7d, or 30d; other filters are not supported',
    );
    return true;
  }

  const range = requestedRange as ConsoleMetricRange;
  const policy = RANGES[range];
  const to = new Date();
  const from = new Date(to.getTime() - policy.durationMs);
  const metrics =
    await getRuntimeStorage().repositories.runtimeEvents.queryConsoleMetrics({
      appId: auth.appId as ConsoleMetricsQuery['appId'],
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: policy.bucket,
    });
  sendJson(res, 200, {
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    bucket: policy.bucket,
    ...metrics,
  });
  return true;
}
