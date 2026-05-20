import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeControlRepository } from '../../../adapters/storage/postgres/runtime-store.js';
import { getRuntimeRepositories } from '../../../adapters/storage/postgres/runtime-store.js';
import { getRuntimeEventExchange } from '../../../adapters/storage/postgres/runtime-store.js';
import { resolveJobAppSession } from '../app-identity.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';
import { parseRunEventsRoute, parseRunRoute } from '../route-parser.js';
import { projectRuntimeEventToRunEvent } from '../run-event-projection.js';

function projectRunForControlApi<T extends object>(
  run: T,
): Omit<
  T,
  | 'provider_session_id'
  | 'provider_run_id'
  | 'providerSessionId'
  | 'providerRunId'
> {
  const {
    provider_session_id: _providerSessionId,
    provider_run_id: _providerRunId,
    providerSessionId: _providerSessionIdCamel,
    providerRunId: _providerRunIdCamel,
    ...safeRun
  } = run as T & Record<string, unknown>;
  return safeRun as Omit<
    T,
    | 'provider_session_id'
    | 'provider_run_id'
    | 'providerSessionId'
    | 'providerRunId'
  >;
}

export async function handleRunRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/runs' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const jobId = url.searchParams.get('jobId') || undefined;
    const ops = getRuntimeRepositories();
    const control = getRuntimeControlRepository();
    if (jobId) {
      const job = await ops.getJobById(jobId);
      const session = job
        ? await resolveJobAppSession(control, job, auth.appId)
        : undefined;
      if (!job || session?.appId !== auth.appId) {
        sendJson(res, 200, { runs: [] });
        return true;
      }
      const runs = await ops.listJobRuns(jobId, 100);
      sendJson(res, 200, { runs: runs.map(projectRunForControlApi) });
      return true;
    }
    const runs = await ops.listJobRuns(undefined, 100, {
      ownerAppId: auth.appId,
    });
    if (runs.length === 0) {
      sendJson(res, 200, { runs: [] });
      return true;
    }
    sendJson(res, 200, { runs: runs.map(projectRunForControlApi) });
    return true;
  }

  const runEventsId = parseRunEventsRoute(pathname);
  if (runEventsId && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const ops = getRuntimeRepositories();
    const run = await ops.getJobRunById(runEventsId);
    if (!run) {
      sendError(res, 404, 'RUN_NOT_FOUND', 'Run not found');
      return true;
    }
    const job = await ops.getJobById(run.job_id);
    const control = getRuntimeControlRepository();
    const session = job
      ? await resolveJobAppSession(control, job, auth.appId)
      : undefined;
    if (!job || session?.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this run');
      return true;
    }
    const events = await getRuntimeEventExchange().list({
      appId: auth.appId as never,
      runId: run.run_id as never,
      limit: 100,
    });
    sendJson(res, 200, {
      events: events.map((event) =>
        projectRuntimeEventToRunEvent(event, run.run_id),
      ),
    });
    return true;
  }

  const runId = parseRunRoute(pathname);
  if (runId && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const run = await getRuntimeRepositories().getJobRunById(runId);
    if (!run) {
      sendError(res, 404, 'RUN_NOT_FOUND', 'Run not found');
      return true;
    }
    const job = await getRuntimeRepositories().getJobById(run.job_id);
    const control = getRuntimeControlRepository();
    const session = job
      ? await resolveJobAppSession(control, job, auth.appId)
      : undefined;
    if (!job || session?.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this run');
      return true;
    }
    sendJson(res, 200, projectRunForControlApi(run));
    return true;
  }

  return false;
}
