import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CreateJobRequestSchema,
  UpdateJobRequestSchema,
  type CreateJobRequest,
  type UpdateJobRequest,
} from '@gantry/contracts';
import type { ZodIssue } from 'zod';

import { ApplicationError } from '../../../application/common/application-error.js';
import { JobManagementService } from '../../../application/jobs/job-management-service.js';
import {
  buildJobListVisibilityMetadata,
  buildJobVisibilityMetadata,
} from '../../../application/jobs/job-visibility-metadata.js';
import { getRuntimeToolRepositoryIfReady } from '../../../adapters/storage/postgres/job-tool-repository-runtime.js';
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
  formatBrowserProfileLabel,
  resolveConversationBrowserProfile,
} from '../../../shared/browser-profile-scope.js';
import { resolveRequestedJobModelPatch } from '../../../application/jobs/job-model-selection.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeRepositories,
  getRuntimeStorage,
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
import { nowMs as currentTimeMs } from '../../../shared/time/datetime.js';
import { modelPreviewFor, resolveCreateJobModel } from './job-model-preview.js';

function sendApplicationError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ApplicationError)) return false;
  switch (error.code) {
    case 'TRIGGER_NOT_FOUND':
      sendError(res, 404, 'TRIGGER_NOT_FOUND', error.message);
      return true;
    case 'NOT_FOUND':
      sendError(res, 404, 'JOB_NOT_FOUND', error.message);
      return true;
    case 'FORBIDDEN':
      sendError(res, 403, 'FORBIDDEN', error.message);
      return true;
    case 'INVALID_SCHEDULE':
    case 'INVALID_REQUEST':
      sendError(res, 400, 'INVALID_REQUEST', error.message);
      return true;
    case 'RATE_LIMITED':
      sendError(res, 429, 'RATE_LIMITED', error.message);
      return true;
    case 'WAIT_TIMEOUT':
      sendError(res, 408, 'WAIT_TIMEOUT', error.message);
      return true;
    case 'SCHEDULER_NOT_READY':
      sendError(res, 503, 'SCHEDULER_NOT_READY', error.message);
      return true;
    case 'CONFLICT':
      sendError(res, 409, 'CONFLICT', error.message);
      return true;
    case 'UNAVAILABLE':
      sendError(res, 503, 'UNAVAILABLE', error.message);
      return true;
    case 'ENQUEUE_FAILED':
      sendError(res, 500, 'ENQUEUE_FAILED', error.message);
      return true;
    case 'NOT_IMPLEMENTED':
      sendError(res, 501, 'NOT_IMPLEMENTED', error.message);
      return true;
  }

  throw error;
}

function formatJobRequestIssue(issue: ZodIssue): string {
  if (issue.code === 'unrecognized_keys' && issue.keys.length > 0) {
    if (issue.keys.includes('groupScope')) {
      return 'groupScope is no longer accepted. Use workspaceKey.';
    }
    if (issue.keys.includes('group_scope')) {
      return 'group_scope is no longer accepted. Use workspace_key.';
    }
    const oldToolField = issue.keys.find(
      (key) => key === 'requiredTools' || key === 'required_tools',
    );
    if (oldToolField) {
      return `${oldToolField} is no longer accepted. Use accessRequirements for access preflight checks.`;
    }
    return `Unsupported job request field "${issue.keys[0]}".`;
  }
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function parseCreateJobRequest(
  res: ServerResponse,
  body: Record<string, unknown>,
): CreateJobRequest | undefined {
  const parsed = CreateJobRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  sendError(
    res,
    400,
    'INVALID_REQUEST',
    formatJobRequestIssue(parsed.error.issues[0]),
  );
  return undefined;
}

function parseUpdateJobRequest(
  res: ServerResponse,
  body: Record<string, unknown>,
): UpdateJobRequest | undefined {
  const parsed = UpdateJobRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  sendError(
    res,
    400,
    'INVALID_REQUEST',
    formatJobRequestIssue(parsed.error.issues[0]),
  );
  return undefined;
}

export function createJobManagementService(ctx?: ControlRouteContext) {
  const control = getRuntimeControlRepository();
  return new JobManagementService({
    ops: getRuntimeRepositories(),
    control: adaptJobControl(control),
    runtimeEvents: getRuntimeEventExchange(),
    scheduler: { requestSchedulerSync },
    schedulePlanner: runtimeJobSchedulePlanner,
    clock: { now: nowIso },
    triggerQueue: {
      isReady: isSchedulerReady,
      enqueue: enqueueJobTrigger,
    },
    toolRepository: getRuntimeToolRepositoryIfReady(),
    skillRepository: getRuntimeStorage().repositories.skills,
    mcpServerRepository: getRuntimeStorage().repositories.mcpServers,
    getCredentialBroker:
      ctx && typeof ctx.app.getCredentialBroker === 'function'
        ? () => ctx.app.getCredentialBroker()
        : undefined,
    getBrowserStatus: ctx?.getBrowserStatus,
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
    async getAppSessionsByIds(sessionIds) {
      const sessions = await control.getAppSessionsByIds(sessionIds);
      return sessions
        .map((session) => adaptAppSession(session))
        .filter((session): session is AppSessionRecord => Boolean(session));
    },
    async getAppSessionByChatJid(chatJid) {
      const session = await control.getAppSessionByChatJid(chatJid);
      return adaptAppSession(session);
    },
    async getAppSessionsByChatJids(chatJids) {
      const sessions = await control.getAppSessionsByChatJids(chatJids);
      return sessions
        .map((session) => adaptAppSession(session))
        .filter((session): session is AppSessionRecord => Boolean(session));
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
  return {
    sessionId: session.sessionId,
    appId: session.appId,
    conversationJid: session.chatJid,
    workspaceKey: session.workspaceKey,
    defaultResponseMode: session.defaultResponseMode,
    defaultWebhookId: session.defaultWebhookId,
  };
}

async function runtimeContextPreviewFor(input: {
  executionContext: {
    conversationJid: string;
    threadId: string | null;
    workspaceKey: string;
    sessionId?: string | null;
  };
  notificationRoutes: Array<{
    conversationJid: string;
    threadId: string | null;
    label: string;
  }>;
  groups: ReturnType<ControlRouteContext['app']['getConversationRoutes']>;
}) {
  const group = input.groups[input.executionContext.conversationJid];
  return {
    executionContext: {
      conversationJid: input.executionContext.conversationJid,
      threadId: input.executionContext.threadId,
      workspaceKey: input.executionContext.workspaceKey,
      ...(input.executionContext.sessionId !== undefined
        ? { sessionId: input.executionContext.sessionId }
        : {}),
    },
    notificationRoutes: input.notificationRoutes,
    browserProfileLabel: formatBrowserProfileLabel({
      agentName: group?.name,
      conversationKind: group?.conversationKind,
    }),
    browserProfileName: resolveConversationBrowserProfile({
      agentId: group?.folder ?? input.executionContext.workspaceKey,
      workspaceKey: input.executionContext.workspaceKey,
      conversationId: input.executionContext.conversationJid,
    }),
    persona: group?.agentConfig?.persona ?? 'developer',
  };
}

function parseJobKind(
  value: string | null,
): 'manual' | 'once' | 'recurring' | undefined {
  return value === 'manual' || value === 'once' || value === 'recurring'
    ? value
    : undefined;
}

function parsePositiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function requestExecutionContextToInternal(input: {
  conversationJid: string;
  threadId: string | null;
  workspaceKey: string;
  sessionId?: string | null;
}) {
  return {
    conversationJid: input.conversationJid,
    threadId: input.threadId,
    workspaceKey: input.workspaceKey,
    sessionId: input.sessionId,
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
    const body = parseCreateJobRequest(
      res,
      (await readJson(req)) as Record<string, unknown>,
    );
    if (!body) return true;
    const kind = body.kind ?? 'manual';
    try {
      const resolvedModel = resolveCreateJobModel({
        modelAlias: body.modelAlias,
        kind,
        getDefaultModelConfig: ctx.getDefaultModelConfig,
        agentFolder: body.executionContext.workspaceKey,
      });
      const executionContext = requestExecutionContextToInternal(
        body.executionContext,
      );
      const created = await createJobManagementService(ctx).createJob({
        appId: auth.appId,
        name: String(body.name || ''),
        prompt: String(body.prompt || ''),
        sessionId: body.executionContext.sessionId,
        executionContext,
        notificationRoutes: body.notificationRoutes,
        accessRequirements: body.accessRequirements,
        kind,
        runAt: typeof body.runAt === 'string' ? body.runAt : undefined,
        schedule: (body.schedule || {}) as { type?: unknown; value?: unknown },
        modelAlias: resolvedModel.explicit
          ? resolvedModel.modelAlias
          : undefined,
        dryRun: body.dryRun,
      });
      const runtimePreviewExecutionContext = {
        conversationJid: created.runtimeContext.conversationJid,
        threadId: created.runtimeContext.threadId,
        workspaceKey: created.runtimeContext.workspaceKey,
        sessionId: created.runtimeContext.sessionId,
      };
      const runtimePreviewNotificationRoutes =
        Array.isArray(body.notificationRoutes) &&
        body.notificationRoutes.length > 0
          ? body.notificationRoutes
          : [
              {
                conversationJid: runtimePreviewExecutionContext.conversationJid,
                threadId: runtimePreviewExecutionContext.threadId,
                label: 'primary',
              },
            ];
      sendJson(res, body.dryRun === true ? 200 : 201, {
        ...(body.dryRun === true ? {} : { jobId: created.jobId }),
        dryRun: body.dryRun === true,
        status:
          created.setupState && created.setupState.state !== 'ready'
            ? 'paused'
            : 'active',
        setup: created.setupState
          ? {
              state: created.setupState.state,
              checkedAt: created.setupState.checked_at,
              fingerprint: created.setupState.fingerprint,
              blockers: created.setupState.blockers,
              nextAction: created.setupState.blockers[0]?.nextAction ?? null,
            }
          : undefined,
        runtimeContext: await runtimeContextPreviewFor({
          executionContext: runtimePreviewExecutionContext,
          notificationRoutes: runtimePreviewNotificationRoutes,
          groups:
            typeof ctx.app.getConversationRoutes === 'function'
              ? ctx.app.getConversationRoutes()
              : {},
        }),
        ...modelPreviewFor({
          explicitAlias: resolvedModel.explicit
            ? resolvedModel.modelAlias
            : undefined,
          kind,
          getDefaultModelConfig: ctx.getDefaultModelConfig,
          agentFolder: created.runtimeContext.workspaceKey,
        }),
        modelSelection: {
          alias: resolvedModel.modelAlias,
          source: resolvedModel.source,
          explicit: resolvedModel.explicit,
        },
        modelSource: resolvedModel.source,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (pathname === '/v1/jobs' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    const service = createJobManagementService(ctx);
    const { jobs: visibleJobs } = await service.listJobs({
      appId: auth.appId,
      statuses: url.searchParams.getAll('status'),
      workspaceKey: url.searchParams.get('workspaceKey') || undefined,
      agentId: url.searchParams.get('agentId') || undefined,
      kind: parseJobKind(url.searchParams.get('kind')),
      conversationJid: url.searchParams.get('conversationJid') || undefined,
      limit: parsePositiveInt(url.searchParams.get('limit')),
    });
    const metadata = await buildJobListVisibilityMetadata({
      jobs: visibleJobs,
      ops: getRuntimeRepositories(),
      toolRepository: getRuntimeToolRepositoryIfReady(),
      skillRepository: getRuntimeStorage().repositories.skills,
      appId: auth.appId,
    });
    sendJson(res, 200, {
      jobs: visibleJobs.map((job) => {
        const jobMetadata = metadata.get(job.id);
        if (!jobMetadata) {
          throw new Error(`Missing visibility metadata for job ${job.id}`);
        }
        return mapManualJobToStored(job, jobMetadata, {
          detail: false,
          getDefaultModelConfig: ctx.getDefaultModelConfig,
        });
      }),
    });
    return true;
  }

  const jobRoute = parseJobRoute(pathname);
  if (jobRoute && req.method === 'GET' && jobRoute.action === 'events') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    try {
      const service = createJobManagementService(ctx);
      const result = await service.listJobEvents({
        appId: auth.appId,
        jobId: jobRoute.jobId,
        runId:
          url.searchParams.get('run') ||
          url.searchParams.get('runId') ||
          undefined,
        eventType: url.searchParams.get('eventType') || undefined,
        sinceId: parsePositiveInt(url.searchParams.get('sinceId')),
        since: url.searchParams.get('since') || undefined,
        limit: parsePositiveInt(url.searchParams.get('limit')),
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  if (jobRoute && req.method === 'GET' && jobRoute.action === 'get') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:read']);
    if (!auth) return true;
    try {
      const service = createJobManagementService(ctx);
      const { job } = await service.getJob({
        appId: auth.appId,
        jobId: jobRoute.jobId,
      });
      if (!job) {
        sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
        return true;
      }
      sendJson(
        res,
        200,
        mapManualJobToStored(
          job,
          await buildJobVisibilityMetadata({
            job,
            ops: getRuntimeRepositories(),
            toolRepository: getRuntimeToolRepositoryIfReady(),
            skillRepository: getRuntimeStorage().repositories.skills,
            appId: auth.appId,
          }),
          { getDefaultModelConfig: ctx.getDefaultModelConfig },
        ),
      );
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  if (jobRoute && req.method === 'DELETE' && jobRoute.action === 'get') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    try {
      await createJobManagementService(ctx).deleteJob({
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
    const body = parseUpdateJobRequest(
      res,
      (await readJson(req)) as Record<string, unknown>,
    );
    if (!body) return true;
    try {
      const service = createJobManagementService(ctx);
      const { job: existingJob } = await service.getJob({
        appId: auth.appId,
        jobId: jobRoute.jobId,
      });
      if (!existingJob) {
        sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
        return true;
      }
      const patchModelWorkload =
        existingJob.schedule_type === 'cron' ||
        existingJob.schedule_type === 'interval'
          ? 'recurring_job'
          : 'one_time_job';
      const requestedModel = resolveRequestedJobModelPatch(
        body.modelAlias,
        patchModelWorkload,
      );
      const { job: updated } = await service.updateJob({
        appId: auth.appId,
        jobId: jobRoute.jobId,
        patch: {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
          ...(body.executionContext !== undefined
            ? {
                executionContext: requestExecutionContextToInternal(
                  body.executionContext,
                ),
              }
            : {}),
          ...(requestedModel.specified ? { model: requestedModel.model } : {}),
          ...(Array.isArray(body.notificationRoutes)
            ? { notificationRoutes: body.notificationRoutes }
            : {}),
          ...(Array.isArray(body.accessRequirements)
            ? { accessRequirements: body.accessRequirements }
            : {}),
          ...(body.status === 'active' || body.status === 'paused'
            ? { status: body.status }
            : {}),
        },
      });
      sendJson(
        res,
        200,
        mapManualJobToStored(
          updated,
          await buildJobVisibilityMetadata({
            job: updated,
            ops: getRuntimeRepositories(),
            toolRepository: getRuntimeToolRepositoryIfReady(),
            skillRepository: getRuntimeStorage().repositories.skills,
            appId: auth.appId,
          }),
          { getDefaultModelConfig: ctx.getDefaultModelConfig },
        ),
      );
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  if (jobRoute?.action === 'pause' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    try {
      const result = await createJobManagementService(ctx).pauseJob({
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
      const result = await createJobManagementService(ctx).resumeJob({
        appId: auth.appId,
        jobId: jobRoute.jobId,
      });
      sendJson(res, 200, {
        resumed: result.resumed,
        setup: result.job.setup_state
          ? {
              state: result.job.setup_state.state,
              checkedAt: result.job.setup_state.checked_at,
              fingerprint: result.job.setup_state.fingerprint,
              blockers: result.job.setup_state.blockers,
              nextAction:
                result.job.setup_state.blockers[0]?.nextAction ?? null,
            }
          : undefined,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }
  if (jobRoute?.action === 'trigger' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
    if (!auth) return true;
    try {
      const result = await createJobManagementService(ctx).triggerJob({
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
    const startedAt = currentTimeMs();
    try {
      const result = await createJobManagementService(ctx).waitForTrigger({
        appId: auth.appId,
        triggerId,
        timeoutMs: Math.max(0, timeoutMs - (currentTimeMs() - startedAt)),
      });
      sendJson(res, 200, result);
      return true;
    } catch (error) {
      if (sendApplicationError(res, error)) return true;
      throw error;
    } finally {
      ctx.state.activeTriggerWaits = Math.max(
        0,
        ctx.state.activeTriggerWaits - 1,
      );
    }
  }

  return false;
}
