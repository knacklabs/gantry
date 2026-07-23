import { ApplicationError } from '../common/application-error.js';
import type { Clock } from '../common/clock.js';
import type {
  Job,
  JobManagementServiceDeps,
  ManagedJobUpdateInput,
} from './job-management-types.js';
import {
  assertSchedulerJobAccess,
  validateSchedulerUpdate,
} from './job-management-access.js';
import {
  buildJobUpdates,
  assertPublicJobNamespace,
  normalizeExecutionContext,
  normalizeNotificationRoutes,
  normalizeStoredNotificationRoutes,
  requireJobNotificationRouteApproval,
  routesBeyondAuthenticatedContext,
} from './job-management-helpers.js';
import { normalizeAccessRequirementsInput } from './job-access-requirements.js';
import {
  applyJobReadinessToUpdates,
  evaluateManagedJobReadiness,
  recordJobSetupRequired,
} from './job-management-readiness.js';
import {
  assertJobAppAccess,
  resolveAuthenticatedRouteContextForUpdate,
} from './job-management-context-access.js';
import {
  assertJobModelHarnessCompatible,
  resolveOptionalJobModel,
} from './job-model-selection.js';

export async function updateManagedJob(
  deps: JobManagementServiceDeps,
  input: ManagedJobUpdateInput,
  clock: Clock,
): Promise<{ job: Job }> {
  const job = await requireJob(deps, input.jobId);
  await assertAccess(deps, job, input);
  const patch = { ...input.patch };
  assertPublicJobNamespace({ jobId: job.id, prompt: patch.prompt });
  const targetWorkspaceKey = patch.workspaceKey ?? job.workspace_key;
  const targetScheduleType = patch.scheduleType ?? job.schedule_type;
  const targetWorkload =
    targetScheduleType === 'cron' || targetScheduleType === 'interval'
      ? 'recurring_job'
      : 'one_time_job';
  if (typeof patch.model === 'string') {
    patch.model = resolveOptionalJobModel(patch.model, targetWorkload);
    assertJobModelHarnessCompatible({
      modelAlias: patch.model,
      workload: targetWorkload,
      agentHarness: input.agentHarness,
    });
  } else if (
    patch.scheduleType !== undefined &&
    patch.model === undefined &&
    job.model
  ) {
    const model = resolveOptionalJobModel(job.model, targetWorkload);
    assertJobModelHarnessCompatible({
      modelAlias: model,
      workload: targetWorkload,
      agentHarness: input.agentHarness,
    });
  }
  const authenticatedContext = await resolveAuthenticatedRouteContextForUpdate({
    deps,
    job,
    appId: input.appId,
    access: input.access,
    workspaceKey: targetWorkspaceKey,
    patchExecutionContext: patch.executionContext,
  });
  const normalizedExecutionContext =
    patch.executionContext === undefined
      ? undefined
      : normalizeExecutionContext(patch.executionContext);
  if (normalizedExecutionContext && !authenticatedContext) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Cannot authorize executionContext changes without authenticated job context.',
    );
  }
  if (
    normalizedExecutionContext &&
    authenticatedContext &&
    (normalizedExecutionContext.conversationJid !==
      authenticatedContext.conversationJid ||
      normalizedExecutionContext.workspaceKey !==
        authenticatedContext.workspaceKey ||
      (input.access &&
        (normalizedExecutionContext.threadId ?? null) !==
          (authenticatedContext.threadId ?? null)))
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'executionContext must match the authenticated job context.',
    );
  }

  const normalizedNotificationRoutes =
    patch.notificationRoutes === undefined
      ? undefined
      : normalizeNotificationRoutes(patch.notificationRoutes);
  const routeAuthorizationContext =
    authenticatedContext ??
    defaultRuntimeSameConversationRouteContext({
      appId: input.appId,
      job,
      routes: normalizedNotificationRoutes,
    });
  const normalizedAccessRequirements = normalizeAccessRequirementsInput(
    patch.accessRequirements,
    'accessRequirements',
  );

  if (normalizedNotificationRoutes) {
    if (!routeAuthorizationContext) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Cannot authorize notification route changes without authenticated job context.',
      );
    }
    await requireJobNotificationRouteApproval({
      deps: deps as never,
      request: {
        operation: 'update',
        jobId: job.id,
        jobName: patch.name ?? job.name,
        authenticatedContext: routeAuthorizationContext,
        requestedRoutes: normalizedNotificationRoutes,
        existingRoutes: normalizeStoredNotificationRoutes(
          job.notification_routes,
        ),
        routesBeyondContext: routesBeyondAuthenticatedContext({
          routes: normalizedNotificationRoutes,
          authenticatedContext: routeAuthorizationContext,
        }),
      },
    });
  }

  const updates = buildJobUpdates(
    job,
    {
      ...patch,
      ...(normalizedExecutionContext
        ? { executionContext: normalizedExecutionContext }
        : {}),
      ...(normalizedNotificationRoutes
        ? { notificationRoutes: normalizedNotificationRoutes }
        : {}),
      ...(normalizedAccessRequirements !== undefined
        ? { accessRequirements: normalizedAccessRequirements }
        : {}),
    },
    deps.schedulePlanner,
    clock,
  );
  if (input.access) validateSchedulerUpdate(job, updates, input.access);
  if (Object.keys(updates).length === 0) return { job };

  const mergedForReadiness = { ...job, ...updates };
  let readinessForSetupEvent:
    Awaited<ReturnType<typeof evaluateManagedJobReadiness>> | undefined;
  if (
    mergedForReadiness.status === 'active' ||
    normalizedAccessRequirements !== undefined
  ) {
    const readiness = await evaluateManagedJobReadiness({
      deps,
      job: mergedForReadiness,
      appId: input.appId,
    });
    applyJobReadinessToUpdates(updates, readiness, {
      clearPauseWhenActive: true,
      mergedStatus: mergedForReadiness.status,
    });
    readinessForSetupEvent = readiness.ready ? undefined : readiness;
  }
  await deps.ops.updateJob(job.id, updates);
  if (readinessForSetupEvent) {
    await recordJobSetupRequired({
      deps,
      job: { ...job, ...updates },
      readiness: readinessForSetupEvent,
      appId: input.appId,
    });
  }
  deps.scheduler.requestSchedulerSync(job.id);
  return { job: { ...job, ...updates } };
}

function defaultRuntimeSameConversationRouteContext(input: {
  appId?: string;
  job: Job;
  routes: ReturnType<typeof normalizeNotificationRoutes> | undefined;
}): {
  conversationJid: string;
  threadId: string | null;
  workspaceKey: string;
} | null {
  if (input.appId !== 'default' || !input.routes?.length) return null;
  const existingConversationJid =
    input.job.execution_context?.conversationJid ??
    input.job.notification_routes?.[0]?.conversationJid;
  if (!existingConversationJid) return null;
  if (
    input.routes.some(
      (route) => route.conversationJid !== existingConversationJid,
    )
  ) {
    return null;
  }
  const targetThreadId =
    input.routes.length === 1 ? (input.routes[0]?.threadId ?? null) : null;
  if (
    input.routes.some((route) => (route.threadId ?? null) !== targetThreadId)
  ) {
    return null;
  }
  return {
    conversationJid: existingConversationJid,
    threadId: targetThreadId,
    workspaceKey: input.job.workspace_key,
  };
}

async function requireJob(
  deps: JobManagementServiceDeps,
  jobId: string,
): Promise<Job> {
  const job = await deps.ops.getJobById(jobId);
  if (!job) throw new ApplicationError('NOT_FOUND', 'Job not found');
  return job;
}

async function assertAccess(
  deps: JobManagementServiceDeps,
  job: Job,
  input: Pick<ManagedJobUpdateInput, 'appId' | 'access'>,
): Promise<void> {
  if (input.appId) await assertJobAppAccess({ deps, job, appId: input.appId });
  if (input.access) assertSchedulerJobAccess(job, input.access);
}
