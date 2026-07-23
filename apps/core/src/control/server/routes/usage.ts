import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const USAGE_GROUPS = new Set(['agent', 'api_key', 'model', 'day'] as const);

function parseDateTime(value: string | null): Date | null {
  if (!value || !ISO_DATE_TIME.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function handleUsageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/v1/usage' || req.method !== 'GET') return false;

  const auth = authorizeControlRequest(req, res, ctx.keys, ['usage:read']);
  if (!auth) return true;

  const from = parseDateTime(url.searchParams.get('from'));
  const to = parseDateTime(url.searchParams.get('to'));
  if (!from || !to) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'from and to are required ISO 8601 date-times',
    );
    return true;
  }
  if (from >= to) {
    sendError(res, 400, 'INVALID_REQUEST', 'from must be before to');
    return true;
  }

  const requestedGroup = url.searchParams.get('group_by');
  if (requestedGroup && !USAGE_GROUPS.has(requestedGroup as never)) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'group_by must be one of agent, api_key, model, or day',
    );
    return true;
  }
  const groupBy = requestedGroup as
    'agent' | 'api_key' | 'model' | 'day' | null;
  const repository = getRuntimeStorage().repositories.runtimeEvents;
  const query = {
    appId: auth.appId,
    from: from.toISOString(),
    to: to.toISOString(),
    agentId: url.searchParams.get('agentId') || undefined,
    apiKeyId: url.searchParams.get('apiKeyId') || undefined,
    runId: url.searchParams.get('runId') || undefined,
    jobId: url.searchParams.get('jobId') || undefined,
    model: url.searchParams.get('model') || undefined,
    groupBy: groupBy || undefined,
  } as Parameters<typeof repository.queryUsage>[0];
  const usage = await repository.queryUsage(query);
  sendJson(res, 200, { usage });
  return true;
}
