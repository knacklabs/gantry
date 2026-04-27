import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ApplicationError } from '../../../application/common/application-error.js';
import { PauseJobUseCase } from '../../../application/jobs/pause-job-use-case.js';
import { UpdateJobUseCase } from '../../../application/jobs/update-job-use-case.js';
import {
  enqueueJobTrigger,
  isSchedulerReady,
  requestSchedulerSync,
} from '../../../jobs/scheduler.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  getRuntimeControlRepository,
  getRuntimeOpsRepository,
} from '../../../adapters/storage/postgres/runtime-store.js';
import type { Job } from '../../../domain/types.js';
import {
  encodeTriggerRequester,
  jobBelongsToApp,
  mapManualJobToStored,
  nowIso,
  resolveJobAppSession,
} from '../app-identity.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  TRIGGER_RATE_LIMIT_PER_APP,
  TRIGGER_RATE_LIMIT_PER_JOB,
} from '../rate-limit.js';
import { parseJobRoute, parseTriggerWaitRoute } from '../route-parser.js';

function sendApplicationError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ApplicationError)) return false;
  switch (error.code) {
    case 'NOT_FOUND':
      sendError(res, 404, 'JOB_NOT_FOUND', error.message);
      return true;
    case 'FORBIDDEN':
      sendError(res, 403, 'FORBIDDEN', error.message);
      return true;
    case 'INVALID_REQUEST':
      sendError(res, 400, 'INVALID_REQUEST', error.message);
      return true;
    case 'CONFLICT':
      sendError(res, 409, 'CONFLICT', error.message);
      return true;
    case 'UNAVAILABLE':
      sendError(res, 503, 'UNAVAILABLE', error.message);
      return true;
    case 'NOT_IMPLEMENTED':
      sendError(res, 501, 'NOT_IMPLEMENTED', error.message);
      return true;
  }
  throw error;
}

function createUpdateJobUseCase() {
  return new UpdateJobUseCase({
    ops: getRuntimeOpsRepository(),
    scheduler: { requestSchedulerSync },
    clock: { now: nowIso },
  });
}

function createPauseJobUseCase() {
  return new PauseJobUseCase({
    ops: getRuntimeOpsRepository(),
    scheduler: { requestSchedulerSync },
  });
}

export async function handleJobRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/jobs' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const control = getRuntimeControlRepository();
    const kind =
      body.kind === 'manual' ||
      body.kind === 'once' ||
      body.kind === 'recurring'
        ? body.kind
        : 'manual';
    const sessionId =
      typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const session = sessionId
      ? await control.getAppSessionById(sessionId)
      : undefined;
    const name = String(body.name || '').trim();
    const prompt = String(body.prompt || '').trim();
    if (!name || !prompt || !session) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'name, prompt, and sessionId are required',
      );
      return true;
    }
    if (auth.appId !== session.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this session');
      return true;
    }
    const jobId = randomUUID();
    let scheduleType: Job['schedule_type'] = 'manual';
    let scheduleValue = nowIso();
    let nextRun: string | null = null;
    if (kind === 'once') {
      scheduleType = 'once';
      scheduleValue = String(body.runAt || '').trim();
      if (!scheduleValue) {
        sendError(
          res,
          400,
          'INVALID_REQUEST',
          'runAt is required for once jobs',
        );
        return true;
      }
      nextRun = scheduleValue || null;
    } else if (kind === 'recurring') {
      const schedule = (body.schedule || {}) as Record<string, unknown>;
      if (schedule.type === 'interval') {
        scheduleType = 'interval';
        scheduleValue = String(schedule.value || '').trim();
        if (!/^[0-9]+$/.test(scheduleValue) || Number(scheduleValue) <= 0) {
          sendError(
            res,
            400,
            'INVALID_REQUEST',
            'interval schedules require a positive numeric value',
          );
          return true;
        }
      } else {
        scheduleType = 'cron';
        scheduleValue = String(schedule.value || '').trim();
        if (!scheduleValue) {
          sendError(
            res,
            400,
            'INVALID_REQUEST',
            'cron schedules require a non-empty value',
          );
          return true;
        }
      }
      nextRun = nowIso();
    } else {
      scheduleType = 'manual';
      scheduleValue = 'manual';
      nextRun = null;
    }
    const ops = getRuntimeOpsRepository();
    await ops.upsertJob({
      id: jobId,
      name,
      prompt,
      model: typeof body.model === 'string' ? body.model : null,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      status: 'active',
      linked_sessions: [session.chatJid],
      session_id: null,
      thread_id: typeof body.threadId === 'string' ? body.threadId : null,
      group_scope: session.groupFolder,
      created_by: 'human',
      next_run: nextRun,
      execution_mode:
        body.executionMode === 'serialized' ? 'serialized' : 'parallel',
    });
    requestSchedulerSync(jobId);
    sendJson(res, 201, { jobId });
    return true;
  }

  if (pathname === '/v1/jobs' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const jobs = await getRuntimeOpsRepository().getAllJobs();
    const visibleJobs = jobs.filter((job) => jobBelongsToApp(job, auth.appId));
    sendJson(res, 200, {
      jobs: visibleJobs.map((job) => mapManualJobToStored(job)),
    });
    return true;
  }

  const jobRoute = parseJobRoute(pathname);
  if (jobRoute && req.method === 'GET' && jobRoute.action === 'get') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const job = await getRuntimeOpsRepository().getJobById(jobRoute.jobId);
    if (!job) {
      sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
      return true;
    }
    if (!jobBelongsToApp(job, auth.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this job');
      return true;
    }
    sendJson(res, 200, mapManualJobToStored(job));
    return true;
  }
  if (jobRoute && req.method === 'DELETE' && jobRoute.action === 'get') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    const job = await getRuntimeOpsRepository().getJobById(jobRoute.jobId);
    if (!job) {
      sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
      return true;
    }
    if (!jobBelongsToApp(job, auth.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this job');
      return true;
    }
    await getRuntimeOpsRepository().deleteJob(jobRoute.jobId);
    requestSchedulerSync(jobRoute.jobId);
    sendJson(res, 200, { deleted: true });
    return true;
  }
  if (jobRoute && req.method === 'PATCH' && jobRoute.action === 'get') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    try {
      const { job: updated } = await createUpdateJobUseCase().execute({
        appId: auth.appId,
        jobId: jobRoute.jobId,
        patch: {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
          ...(body.executionMode === 'serialized' ||
          body.executionMode === 'parallel'
            ? { executionMode: body.executionMode }
            : {}),
          ...(typeof body.threadId === 'string'
            ? { threadId: body.threadId }
            : {}),
          ...(body.status === 'active' || body.status === 'paused'
            ? { status: body.status }
            : {}),
        },
      });
      sendJson(res, 200, mapManualJobToStored(updated));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  if (jobRoute?.action === 'pause' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    try {
      const result = await createPauseJobUseCase().execute({
        appId: auth.appId,
        jobId: jobRoute.jobId,
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  if (jobRoute?.action === 'resume' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    try {
      await createUpdateJobUseCase().execute({
        appId: auth.appId,
        jobId: jobRoute.jobId,
        resume: true,
      });
      sendJson(res, 200, { resumed: true });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  if (jobRoute?.action === 'trigger' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    const ops = getRuntimeOpsRepository();
    const control = getRuntimeControlRepository();
    const job = await ops.getJobById(jobRoute.jobId);
    if (!job) {
      sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
      return true;
    }
    if (!jobBelongsToApp(job, auth.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this job');
      return true;
    }
    const appSession = await resolveJobAppSession(control, job, auth.appId);
    if (!appSession) {
      sendError(
        res,
        403,
        'FORBIDDEN',
        'API key cannot access this job session',
      );
      return true;
    }
    if (!isSchedulerReady()) {
      sendError(
        res,
        503,
        'SCHEDULER_NOT_READY',
        'Scheduler is not ready to accept job triggers',
      );
      return true;
    }
    if (
      !ctx.triggerRateLimiter.consume(
        `app:${auth.appId}`,
        TRIGGER_RATE_LIMIT_PER_APP,
      ) ||
      !ctx.triggerRateLimiter.consume(
        `app:${auth.appId}:job:${job.id}`,
        TRIGGER_RATE_LIMIT_PER_JOB,
      )
    ) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many job trigger requests');
      return true;
    }
    const trigger = await control.createJobTrigger({
      jobId: job.id,
      requestedBy: encodeTriggerRequester({
        appId: auth.appId,
        sessionId: appSession.sessionId,
      }),
    });
    if (job.status === 'paused' || job.status === 'dead_lettered') {
      await createUpdateJobUseCase().execute({
        appId: auth.appId,
        jobId: job.id,
        resume: true,
      });
    }
    try {
      await enqueueJobTrigger(job.id, trigger.triggerId);
    } catch (error) {
      await control.markTriggerCompleted(trigger.triggerId, 'failed');
      logger.warn(
        { err: error, jobId: job.id, triggerId: trigger.triggerId },
        'Failed to enqueue job trigger',
      );
      sendError(
        res,
        503,
        'SCHEDULER_NOT_READY',
        'Scheduler is not ready to accept job triggers',
      );
      return true;
    }
    await control.addControlEvent({
      eventType: 'job.triggered',
      payload: JSON.stringify({
        triggerId: trigger.triggerId,
        jobId: job.id,
      }),
      actor: 'sdk',
      sessionId: appSession.sessionId,
      jobId: job.id,
      triggerId: trigger.triggerId,
      responseMode: appSession.defaultResponseMode,
      webhookId: appSession.defaultWebhookId,
    });
    sendJson(res, 202, {
      triggerId: trigger.triggerId,
    });
    return true;
  }

  const triggerId = parseTriggerWaitRoute(pathname);
  if (triggerId && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    if (ctx.state.activeTriggerWaits >= ctx.maxConcurrentTriggerWaits) {
      sendError(
        res,
        429,
        'TOO_MANY_WAITS',
        'Too many active trigger wait requests',
      );
      return true;
    }
    ctx.state.activeTriggerWaits += 1;
    const timeoutMs = Math.min(
      300_000,
      Math.max(1000, Number(url.searchParams.get('timeoutMs') || 60_000)),
    );
    const startedAt = Date.now();
    const control = getRuntimeControlRepository();
    const ops = getRuntimeOpsRepository();
    try {
      const initialTrigger = await control.getTriggerById(triggerId);
      if (!initialTrigger) {
        sendError(res, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found');
        return true;
      }
      const job = await ops.getJobById(initialTrigger.jobId);
      if (!job) {
        sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
        return true;
      }
      if (!jobBelongsToApp(job, auth.appId)) {
        sendError(res, 403, 'FORBIDDEN', 'API key cannot access this trigger');
        return true;
      }
      while (Date.now() - startedAt < timeoutMs) {
        const trigger = await control.getTriggerById(triggerId);
        if (!trigger) {
          sendError(res, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found');
          return true;
        }
        if (trigger.runId) {
          const run = await ops.getJobRunById(trigger.runId);
          if (run && run.status !== 'running') {
            sendJson(res, 200, {
              triggerId: trigger.triggerId,
              runId: run.run_id,
              status: run.status,
              resultSummary: run.result_summary,
              errorSummary: run.error_summary,
            });
            return true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      sendError(
        res,
        408,
        'WAIT_TIMEOUT',
        'Timed out waiting for trigger completion',
      );
      return true;
    } finally {
      ctx.state.activeTriggerWaits = Math.max(
        0,
        ctx.state.activeTriggerWaits - 1,
      );
    }
  }

  return false;
}
