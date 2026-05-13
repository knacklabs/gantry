import { ApplicationError } from '../common/application-error.js';
import type {
  CreateManagedJobInput,
  JobManagementServiceDeps,
} from './job-management-types.js';
import { resolveRequestedJobModel } from './job-model-selection.js';
import {
  normalizeExecutionContext,
  normalizeNotificationRoutes,
  requireJobNotificationRouteApproval,
  routesBeyondAuthenticatedContext,
} from './job-management-helpers.js';

export async function createManagedJob(
  deps: JobManagementServiceDeps,
  input: CreateManagedJobInput,
) {
  if (!deps.control) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Job control repository unavailable',
    );
  }
  const session = await deps.control.getAppSessionById(input.sessionId);
  if (!input.name.trim() || !input.prompt.trim() || !session) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'name, prompt, and sessionId are required',
    );
  }
  if (session.appId !== input.appId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'API key cannot access this session',
    );
  }

  const kind = input.kind ?? 'manual';
  const schedule = deps.schedulePlanner.planAppSchedule({
    kind,
    runAt: input.runAt,
    schedule: input.schedule,
  });
  const modelAlias = resolveRequestedJobModel(
    input.modelAlias,
    input.modelProfileId,
  );
  const jobId = deps.schedulePlanner.createManualJobId();
  const sessionBoundContext = {
    conversationJid: session.conversationJid,
    groupScope: session.workspaceKey,
  };
  const executionContext =
    input.executionContext !== undefined
      ? normalizeExecutionContext(input.executionContext)
      : {
          ...sessionBoundContext,
          threadId: null,
          sessionId: session.sessionId,
        };
  if (
    executionContext.conversationJid !== sessionBoundContext.conversationJid ||
    executionContext.groupScope !== sessionBoundContext.groupScope
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'executionContext must match authenticated job context.',
    );
  }
  if (
    executionContext.sessionId !== undefined &&
    executionContext.sessionId !== session.sessionId
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'executionContext.sessionId must match the authenticated app session.',
    );
  }
  const runtimeContext = {
    sessionId: session.sessionId,
    conversationJid: session.conversationJid,
    groupScope: session.workspaceKey,
    threadId: executionContext.threadId ?? null,
  };
  const notificationRoutes = normalizeNotificationRoutes(
    input.notificationRoutes ?? [
      {
        conversationJid: sessionBoundContext.conversationJid,
        threadId: executionContext.threadId ?? null,
        label: 'primary',
      },
    ],
  );
  const authenticatedContext = {
    ...sessionBoundContext,
    threadId: executionContext.threadId ?? null,
  };
  const routesBeyondContext = routesBeyondAuthenticatedContext({
    routes: notificationRoutes,
    authenticatedContext,
  });
  if (input.dryRun === true) {
    return { jobId, created: false, modelAlias, runtimeContext };
  }
  await requireJobNotificationRouteApproval({
    deps: deps as never,
    request: {
      operation: 'create',
      jobId,
      jobName: input.name.trim(),
      authenticatedContext,
      requestedRoutes: notificationRoutes,
      existingRoutes: [],
      routesBeyondContext,
    },
  });
  const result = await deps.ops.upsertJob({
    id: jobId,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    model: modelAlias ?? null,
    schedule_type: schedule.scheduleType,
    schedule_value: schedule.scheduleValue,
    status: 'active',
    session_id: session.sessionId,
    thread_id: executionContext.threadId ?? null,
    group_scope: session.workspaceKey,
    created_by: 'human',
    next_run: schedule.nextRun,
    execution_context: executionContext,
    notification_routes: notificationRoutes,
  });
  deps.scheduler.requestSchedulerSync(jobId);
  return { jobId, created: result.created, modelAlias, runtimeContext };
}
