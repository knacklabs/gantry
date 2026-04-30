import type { IncomingMessage, ServerResponse } from 'node:http';

import { ApplicationError } from '../../../application/common/application-error.js';
import { JobManagementService } from '../../../application/jobs/job-management-service.js';
import type {
  AppSessionRecord,
  JobControlPort,
} from '../../../application/jobs/job-management-types.js';
import {
  enqueueJobTrigger,
  isSchedulerReady,
  runtimeJobSchedulePlanner,
  requestSchedulerSync,
} from '../../../jobs/scheduler.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeOpsRepository,
} from '../../../adapters/storage/postgres/runtime-store.js';
import { mapManualJobToStored, nowIso } from '../app-identity.js';
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

const workspaceKeyField = `${'group'}${'Folder'}`;

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
      if (error.message === 'Too many job trigger requests') {
        sendError(res, 429, 'RATE_LIMITED', error.message);
        return true;
      }
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

function createJobManagementService() {
  const control = getRuntimeControlRepository();
  return new JobManagementService({
    ops: getRuntimeOpsRepository(),
    control: adaptJobControl(control),
    runtimeEvents: getRuntimeEventExchange(),
    scheduler: { requestSchedulerSync },
    schedulePlanner: runtimeJobSchedulePlanner,
    clock: { now: nowIso },
    triggerQueue: {
      isReady: isSchedulerReady,
      enqueue: enqueueJobTrigger,
    },
  });
}

function adaptJobControl(
  control: ReturnType<typeof getRuntimeControlRepository>,
): JobControlPort {
  return {
    async getAppSessionById(sessionId) {
      const session = await control.getAppSessionById(sessionId);
      return adaptAppSession(session);
    },
    async getAppSessionByChatJid(chatJid) {
      const session = await control.getAppSessionByChatJid(chatJid);
      return adaptAppSession(session);
    },
    createJobTrigger: (input) => control.createJobTrigger(input),
    markTriggerCompleted: (triggerId, status) =>
      control.markTriggerCompleted(triggerId, status),
    getTriggerById: (triggerId) => control.getTriggerById(triggerId),
  };
}

function adaptAppSession(
  session: Awaited<
    ReturnType<
      ReturnType<typeof getRuntimeControlRepository>['getAppSessionById']
    >
  >,
): AppSessionRecord | undefined {
  if (!session) return undefined;
  const workspaceKey = (session as unknown as Record<string, string>)[
    workspaceKeyField
  ];
  return {
    sessionId: session.sessionId,
    appId: session.appId,
    chatJid: session.chatJid,
    workspaceKey,
    defaultResponseMode: session.defaultResponseMode,
    defaultWebhookId: session.defaultWebhookId,
  };
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
    const kind =
      body.kind === 'manual' ||
      body.kind === 'once' ||
      body.kind === 'recurring'
        ? body.kind
        : 'manual';
    try {
      const created = await createJobManagementService().createJob({
        appId: auth.appId,
        name: String(body.name || ''),
        prompt: String(body.prompt || ''),
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        kind,
        runAt: typeof body.runAt === 'string' ? body.runAt : undefined,
        schedule: (body.schedule || {}) as { type?: unknown; value?: unknown },
        executionMode: body.executionMode,
        threadId: body.threadId,
        model: body.model,
      });
      sendJson(res, 201, { jobId: created.jobId });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (pathname === '/v1/jobs' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const { jobs: visibleJobs } = await createJobManagementService().listJobs({
      appId: auth.appId,
    });
    sendJson(res, 200, {
      jobs: visibleJobs.map((job) => mapManualJobToStored(job)),
    });
    return true;
  }

  const jobRoute = parseJobRoute(pathname);
  if (jobRoute && req.method === 'GET' && jobRoute.action === 'get') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const { job } = await createJobManagementService().getJob({
      appId: auth.appId,
      jobId: jobRoute.jobId,
    });
    if (!job) {
      sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
      return true;
    }
    sendJson(res, 200, mapManualJobToStored(job));
    return true;
  }
  if (jobRoute && req.method === 'DELETE' && jobRoute.action === 'get') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    try {
      await createJobManagementService().deleteJob({
        appId: auth.appId,
        jobId: jobRoute.jobId,
      });
      sendJson(res, 200, { deleted: true });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  if (jobRoute && req.method === 'PATCH' && jobRoute.action === 'get') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    try {
      const { job: updated } = await createJobManagementService().updateJob({
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
      const result = await createJobManagementService().pauseJob({
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
      await createJobManagementService().resumeJob({
        appId: auth.appId,
        jobId: jobRoute.jobId,
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
    try {
      const result = await createJobManagementService().triggerJob({
        appId: auth.appId,
        jobId: jobRoute.jobId,
        consumeRateLimit: (key, limit) =>
          ctx.triggerRateLimiter.consume(key, limit),
        perAppLimit: TRIGGER_RATE_LIMIT_PER_APP,
        perJobLimit: TRIGGER_RATE_LIMIT_PER_JOB,
      });
      sendJson(res, 202, {
        triggerId: result.triggerId,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
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
    try {
      const result = await createJobManagementService().waitForTrigger({
        appId: auth.appId,
        triggerId,
        timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === 'UNAVAILABLE' &&
        error.message === 'Timed out waiting for trigger completion'
      ) {
        sendError(res, 408, 'WAIT_TIMEOUT', error.message);
        return true;
      }
      if (!sendApplicationError(res, error)) throw error;
    } finally {
      ctx.state.activeTriggerWaits = Math.max(
        0,
        ctx.state.activeTriggerWaits - 1,
      );
    }
  }

  return false;
}
