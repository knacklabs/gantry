import { createHash } from 'node:crypto';
import { ApplicationError } from '../common/application-error.js';
import type {
  CreateManagedJobInput,
  JobManagementServiceDeps,
} from './job-management-types.js';
import type { JobUpsertInput } from '../../domain/repositories/ops-repo.js';
import {
  assertJobModelHarnessCompatible,
  resolveRequestedJobModel,
} from './job-model-selection.js';
import {
  normalizeExecutionContext,
  normalizeNotificationRoutes,
  assertPublicJobNamespace,
  requireJobNotificationRouteApproval,
  routesBeyondAuthenticatedContext,
} from './job-management-helpers.js';
import { normalizeAccessRequirements } from './job-access-requirements.js';
import {
  evaluateJobReadiness,
  SETUP_REQUIRED_PAUSE_REASON,
} from './job-readiness-service.js';
import { recordJobSetupRequired } from './job-management-readiness.js';
import { hostTaskCapabilityId } from '../../jobs/host-task-executors.js';

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
  const prompt = input.prompt?.trim() ?? '';
  if (!input.name.trim() || (!prompt && !input.target) || !session) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'name, prompt or target, and sessionId are required',
    );
  }
  if (session.appId !== input.appId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'API key cannot access this session',
    );
  }
  if (prompt) assertPublicJobNamespace({ prompt });

  const kind = input.kind ?? 'manual';
  const schedule = deps.schedulePlanner.planAppSchedule({
    kind,
    runAt: input.runAt,
    schedule: input.schedule,
  });
  const workload = kind === 'recurring' ? 'recurring_job' : 'one_time_job';
  const modelAlias = resolveRequestedJobModel(input.modelAlias, workload);
  const effectiveModelAlias =
    modelAlias ?? resolveRequestedJobModel(input.effectiveModelAlias, workload);
  assertJobModelHarnessCompatible({
    modelAlias: effectiveModelAlias,
    workload,
    agentHarness: input.agentHarness,
  });
  const sessionBoundContext = {
    conversationJid: session.conversationJid,
    workspaceKey: session.workspaceKey,
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
    executionContext.workspaceKey !== sessionBoundContext.workspaceKey
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
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey && input.dryRun !== true) {
    const existingJobs = await deps.ops.listJobs({
      workspaceKey: session.workspaceKey,
      conversationJid: session.conversationJid,
    });
    const existing = existingJobs.find(
      (job) =>
        job.idempotency_key === idempotencyKey &&
        job.session_id === session.sessionId,
    );
    if (existing) {
      return {
        jobId: existing.id,
        created: false,
        modelAlias,
        runtimeContext: {
          sessionId: session.sessionId,
          conversationJid: session.conversationJid,
          workspaceKey: session.workspaceKey,
          threadId: existing.thread_id ?? executionContext.threadId ?? null,
        },
        setupState: existing.setup_state,
      };
    }
  }
  const jobId = idempotencyKey
    ? createIdempotentJobId({
        appId: session.appId,
        sessionId: session.sessionId,
        idempotencyKey,
      })
    : deps.schedulePlanner.createManualJobId();
  const runtimeContext = {
    sessionId: session.sessionId,
    conversationJid: session.conversationJid,
    workspaceKey: session.workspaceKey,
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
  const accessRequirements = normalizeAccessRequirements(
    input.accessRequirements ?? [],
  );
  const authenticatedContext = {
    ...sessionBoundContext,
    threadId: executionContext.threadId ?? null,
  };
  const routesBeyondContext = routesBeyondAuthenticatedContext({
    routes: notificationRoutes,
    authenticatedContext,
  });
  const jobInput: JobUpsertInput = {
    id: jobId,
    name: input.name.trim(),
    prompt,
    model: modelAlias ?? null,
    schedule_type: schedule.scheduleType,
    schedule_value: schedule.scheduleValue,
    status: 'active',
    session_id: session.sessionId,
    thread_id: executionContext.threadId ?? null,
    workspace_key: session.workspaceKey,
    created_by: 'human',
    next_run: schedule.nextRun,
    execution_context: executionContext,
    notification_routes: notificationRoutes,
    access_requirements: accessRequirements,
    idempotency_key: idempotencyKey,
    host_task: input.target ?? null,
    required_capabilities: input.target
      ? [hostTaskCapabilityId(input.target.executorId)]
      : undefined,
  };
  const readiness = await evaluateJobReadiness({
    job: jobInput,
    appId: session.appId,
    toolRepository: deps.toolRepository,
    skillRepository: deps.skillRepository,
    mcpServerRepository: deps.mcpServerRepository,
    capabilitySecretRepository: deps.capabilitySecretRepository,
    credentialBroker: await deps.getCredentialBroker?.(),
    getBrowserStatus: deps.getBrowserStatus,
    clock: deps.clock,
  });
  if (input.dryRun === true) {
    return {
      jobId,
      created: false,
      modelAlias,
      runtimeContext,
      setupState: readiness.setupState,
      status: readiness.ready ? 'active' : 'paused',
      pauseReason: readiness.ready ? null : SETUP_REQUIRED_PAUSE_REASON,
    };
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
    ...jobInput,
    status: readiness.ready ? 'active' : 'paused',
    pause_reason: readiness.ready ? null : SETUP_REQUIRED_PAUSE_REASON,
    next_run: readiness.ready ? schedule.nextRun : null,
    setup_state: readiness.setupState,
  });
  if (!readiness.ready) {
    await recordJobSetupRequired({
      deps,
      job: jobInput,
      readiness,
      appId: session.appId,
    });
  }
  deps.scheduler.requestSchedulerSync(jobId);
  return {
    jobId,
    created: result.created,
    modelAlias,
    runtimeContext,
    setupState: readiness.setupState,
  };
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function createIdempotentJobId(input: {
  readonly appId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
}): string {
  const digest = createHash('sha256')
    .update(input.appId)
    .update('\0')
    .update(input.sessionId)
    .update('\0')
    .update(input.idempotencyKey)
    .digest('hex')
    .slice(0, 32);
  return `job-idem-${digest}`;
}
