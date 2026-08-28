import type { Job } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
// prettier-ignore
import { ASSISTANT_NAME, getEffectiveModelConfig, getRuntimeSettingsForConfig, getSelectedAgentHarness } from '../config/index.js';
// prettier-ignore
import { getConfiguredModelProvidersForApp, getRuntimeControlRepository, getRuntimeEventExchange, getWorkerCoordinationRepository } from '../adapters/storage/postgres/runtime-store.js';
import { completeFailedRunFailsafe } from './run-failsafe.js';
import { runActiveJobWithLogContext } from './execution-log-context.js';
import {
  claimActiveJobLease,
  createActiveJobRunContext,
  prepareActiveJobSession,
  resolveActiveJobExecution,
  resolveActiveJobModel,
} from './execution-phases-setup.js';
import {
  bindActiveJobRun,
  deleteCompletedOneShotJob,
  finalizeActiveJobRun,
  publishActiveJobTerminal,
  runActiveJobAgent,
  runActiveJobSystemTurn,
} from './execution-phases-run.js';
import type {
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from './types.js';

export async function runJob(
  job: Job,
  deps: SchedulerDependencies,
  queueJid: string,
  dispatch?: SchedulerDispatchPayload,
  control?: { abortSignal?: AbortSignal },
): Promise<void> {
  return runActiveJobWithLogContext({
    requestedJob: job,
    dispatch,
    getJobById: (jobId) => deps.opsRepository.getJobById(jobId),
    run: ({ job: currentJob, scheduledFor, runId }) =>
      runActiveJob(
        currentJob,
        deps,
        queueJid,
        dispatch,
        control,
        scheduledFor,
        runId,
      ),
  });
}

async function runActiveJob(
  currentJob: Job,
  deps: SchedulerDependencies,
  queueJid: string,
  dispatch: SchedulerDispatchPayload | undefined,
  control: { abortSignal?: AbortSignal } | undefined,
  scheduledFor: string,
  runId: string,
): Promise<void> {
  const context = createActiveJobRunContext({
    currentJob,
    deps,
    queueJid,
    dispatch,
    control,
    scheduledFor,
    runId,
    assistantName: ASSISTANT_NAME,
    runtime: {
      getEffectiveModelConfig: (useKind, agentFolder) =>
        getEffectiveModelConfig(undefined, useKind, agentFolder),
      getModelFamilies: () => getRuntimeSettingsForConfig().modelFamilies,
      getSelectedAgentHarness,
      getConfiguredModelProvidersForApp,
      getRuntimeControlRepository,
      getRuntimeEventExchange,
      getWorkerCoordinationRepository,
    },
  });
  if (!(await resolveActiveJobExecution(context))) return;
  await resolveActiveJobModel(context);
  if (!(await prepareActiveJobSession(context))) {
    return void deps.discardLifecycleNotification?.(runId);
  }
  if (!(await claimActiveJobLease(context))) {
    return void deps.discardLifecycleNotification?.(runId);
  }
  try {
    await bindActiveJobRun(context);
    if (!(await runActiveJobSystemTurn(context))) {
      await runActiveJobAgent(context);
    }
    await finalizeActiveJobRun(context);
    await publishActiveJobTerminal(context);
    await deleteCompletedOneShotJob(context);
  } finally {
    context.leaseHeartbeat!.stop();
    try {
      if (!context.settled && !context.deleted)
        await completeFailedRunFailsafe({
          opsRepository: deps.opsRepository,
          ...context.leaseContext!.lease,
          jobId: currentJob.id,
          recordRunnerControlEvent:
            context.leaseContext!.recordRunnerControlEvent,
          logger,
        });
    } finally {
      await context.lifecycle!.retire(context.deleted);
    }
  }
}
