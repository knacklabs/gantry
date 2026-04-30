import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Job } from '../../../domain/types.js';
import { getRuntimeOpsRepository } from '../../../adapters/storage/postgres/runtime-store.js';
import { getRuntimeEventExchange } from '../../../adapters/storage/postgres/runtime-store.js';
import { jobBelongsToApp } from '../app-identity.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';
import { parseRunEventsRoute, parseRunRoute } from '../route-parser.js';
import { projectRuntimeEventToRunEvent } from '../run-event-projection.js';

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
    const ops = getRuntimeOpsRepository();
    const runs = await ops.listJobRuns(jobId, 100);
    const jobs = jobId ? [await ops.getJobById(jobId)] : await ops.getAllJobs();
    const visibleJobIds = new Set(
      jobs
        .filter((job): job is Job => Boolean(job))
        .filter((job) => jobBelongsToApp(job, auth.appId))
        .map((job) => job.id),
    );
    const visibleRuns = [];
    for (const run of runs) {
      if (visibleJobIds.has(run.job_id)) visibleRuns.push(run);
    }
    sendJson(res, 200, { runs: visibleRuns });
    return true;
  }

  const runEventsId = parseRunEventsRoute(pathname);
  if (runEventsId && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const ops = getRuntimeOpsRepository();
    const run = await ops.getJobRunById(runEventsId);
    if (!run) {
      sendError(res, 404, 'RUN_NOT_FOUND', 'Run not found');
      return true;
    }
    const job = await ops.getJobById(run.job_id);
    if (!job || !jobBelongsToApp(job, auth.appId)) {
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
    const run = await getRuntimeOpsRepository().getJobRunById(runId);
    if (!run) {
      sendError(res, 404, 'RUN_NOT_FOUND', 'Run not found');
      return true;
    }
    const job = await getRuntimeOpsRepository().getJobById(run.job_id);
    if (!job || !jobBelongsToApp(job, auth.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this run');
      return true;
    }
    sendJson(res, 200, run);
    return true;
  }

  return false;
}
