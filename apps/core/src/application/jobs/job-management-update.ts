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
  normalizeExecutionContext,
  normalizeNotificationRoutes,
  normalizeStoredNotificationRoutes,
  requireJobNotificationRouteApproval,
  routesBeyondAuthenticatedContext,
} from './job-management-helpers.js';
import {
  normalizeRequiredMcpServersInput,
  normalizeToolAccessRequirements,
  normalizeToolAccessRequirementsInput,
} from './job-tool-access-requirements.js';
import {
  capabilityRequirementToolRules,
  normalizeCapabilityRequirements,
} from './job-capability-requirements.js';
import {
  applyJobReadinessToUpdates,
  evaluateManagedJobReadiness,
  recordJobSetupRequired,
} from './job-management-readiness.js';
import {
  assertJobAppAccess,
  resolveAuthenticatedRouteContextForUpdate,
} from './job-management-context-access.js';
import { resolveOptionalJobModel } from './job-model-selection.js';

export async function updateManagedJob(
  deps: JobManagementServiceDeps,
  input: ManagedJobUpdateInput,
  clock: Clock,
): Promise<{ job: Job }> {
  const job = await requireJob(deps, input.jobId);
  await assertAccess(deps, job, input);
  const patch = { ...input.patch };
  const targetGroupScope = patch.groupScope ?? job.group_scope;
  const targetScheduleType = patch.scheduleType ?? job.schedule_type;
  if (typeof patch.model === 'string') {
    patch.model = resolveOptionalJobModel(
      patch.model,
      targetScheduleType === 'cron' || targetScheduleType === 'interval'
        ? 'recurring_job'
        : 'one_time_job',
    );
  }
  const authenticatedContext = await resolveAuthenticatedRouteContextForUpdate({
    deps,
    job,
    appId: input.appId,
    access: input.access,
    groupScope: targetGroupScope,
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
      normalizedExecutionContext.groupScope !==
        authenticatedContext.groupScope ||
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
  const normalizedToolAccessRequirements = normalizeToolAccessRequirementsInput(
    patch.toolAccessRequirements,
    'toolAccessRequirements',
  );
  const normalizedCapabilityRequirements =
    patch.capabilityRequirements !== undefined
      ? normalizeCapabilityRequirements(patch.capabilityRequirements)
      : undefined;
  const effectiveCapabilityRequirements =
    normalizedCapabilityRequirements ?? job.capability_requirements ?? [];
  const previousCapabilityRules =
    normalizedCapabilityRequirements !== undefined
      ? new Set(capabilityRequirementToolRules(job.capability_requirements))
      : undefined;
  const toolAccessRequirementsForUpdate =
    normalizedToolAccessRequirements !== undefined
      ? normalizedToolAccessRequirements
      : (job.tool_access_requirements ?? []).filter(
          (rule) => !previousCapabilityRules?.has(rule),
        );
  const effectiveToolAccessRequirements = normalizeToolAccessRequirements([
    ...toolAccessRequirementsForUpdate,
    ...capabilityRequirementToolRules(effectiveCapabilityRequirements),
  ]);
  const normalizedRequiredMcpServers = normalizeRequiredMcpServersInput(
    patch.requiredMcpServers,
    'requiredMcpServers',
  );

  if (normalizedNotificationRoutes) {
    if (!authenticatedContext) {
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
        authenticatedContext,
        requestedRoutes: normalizedNotificationRoutes,
        existingRoutes: normalizeStoredNotificationRoutes(
          job.notification_routes,
        ),
        routesBeyondContext: routesBeyondAuthenticatedContext({
          routes: normalizedNotificationRoutes,
          authenticatedContext,
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
      ...(normalizedToolAccessRequirements !== undefined ||
      normalizedCapabilityRequirements !== undefined
        ? { toolAccessRequirements: effectiveToolAccessRequirements }
        : {}),
      ...(normalizedCapabilityRequirements !== undefined
        ? { capabilityRequirements: normalizedCapabilityRequirements }
        : {}),
      ...(normalizedRequiredMcpServers !== undefined
        ? { requiredMcpServers: normalizedRequiredMcpServers }
        : {}),
    },
    deps.schedulePlanner,
    clock,
  );
  if (input.access) validateSchedulerUpdate(job, updates, input.access);
  if (Object.keys(updates).length === 0) return { job };

  const mergedForReadiness = { ...job, ...updates };
  let readinessForSetupEvent:
    | Awaited<ReturnType<typeof evaluateManagedJobReadiness>>
    | undefined;
  if (
    mergedForReadiness.status === 'active' ||
    normalizedToolAccessRequirements !== undefined ||
    normalizedCapabilityRequirements !== undefined ||
    normalizedRequiredMcpServers !== undefined
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
