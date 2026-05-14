import { JobManagementService } from '../application/jobs/job-management-service.js';
import type { JobScheduleType } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { TaskHandler, TaskContext } from './ipc-types.js';
import { invalidateSystemJobRegistrationSignature } from './system-registration-cache.js';
import { createTaskResponder } from './ipc-shared.js';
import { mapApplicationError } from './ipc-application-error.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';
import { getDefaultModelConfig } from '../config/index.js';
import {
  findModelByRunnerModel,
  resolveModelSelection,
} from '../shared/model-catalog.js';
import { formatBrowserProfileLabel } from '../shared/browser-profile-scope.js';
import { schedulerAccessFromContext } from './ipc-scheduler-access.js';
import {
  formatSchedulerJobPlan,
  schedulerJobConfirmationToken,
  type SchedulerJobPlanInput,
} from './job-plan-formatter.js';

type SchedulerCreateScheduleType = Exclude<JobScheduleType, 'manual'>;

function makeJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    control: context.deps.getJobControl?.(),
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
    toolRepository: context.deps.getToolRepository?.(),
    mcpServerRepository: context.deps.getMcpServerRepository?.(),
    getCredentialBroker: context.deps.getCredentialBroker,
    getBrowserStatus: context.deps.getBrowserStatus,
  });
}

function scheduleType(raw: unknown): SchedulerCreateScheduleType | undefined {
  return raw === 'cron' || raw === 'interval' || raw === 'once'
    ? raw
    : undefined;
}

const schedulerUpsertJobHandler: TaskHandler = async (context) => {
  const {
    data,
    sourceAgentFolder,
    conversationBindings,
    sourceAgentFolderJids,
  } = context;
  const { accept, acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );

  if (
    data.scheduleType === undefined ||
    data.scheduleType === null ||
    data.scheduleType === ''
  ) {
    reject('scheduler_upsert_job requires scheduleType.', 'invalid_request');
    return;
  }
  const normalizedScheduleType = scheduleType(data.scheduleType);
  if (!normalizedScheduleType) {
    reject('Unsupported schedule type.', 'invalid_schedule');
    return;
  }

  try {
    const planInput: SchedulerJobPlanInput = {
      jobId: data.jobId,
      name: data.name || '',
      prompt: data.prompt || '',
      modelAlias: data.modelAlias || null,
      modelProfileId: data.modelProfileId || null,
      scheduleType: normalizedScheduleType,
      scheduleValue: data.scheduleValue || '',
      executionContext: data.executionContext,
      notificationRoutes: data.notificationRoutes,
      requiredTools: data.requiredTools,
      requiredMcpServers: data.requiredMcpServers,
      silent: data.silent,
      cleanupAfterMs: data.cleanupAfterMs,
      timeoutMs: data.timeoutMs,
      maxRetries: data.maxRetries,
      retryBackoffMs: data.retryBackoffMs,
      maxConsecutiveFailures: data.maxConsecutiveFailures,
      createdBy: data.createdBy,
    };
    const confirmationToken = schedulerJobConfirmationToken(planInput);
    if (data.confirm !== true) {
      acceptData(
        formatSchedulerJobPlan({ ...planInput, confirmationToken }),
        {
          type: 'scheduler_job_plan',
          confirmationToken,
        },
        'confirmation_required',
      );
      return;
    }
    if (data.confirmationToken !== confirmationToken) {
      reject(
        'Scheduler upsert confirmation token is missing or does not match the current job plan.',
        'confirmation_mismatch',
      );
      return;
    }

    const result = await makeJobService(context).upsertJobFromIpc({
      access: schedulerAccessFromContext(context),
      jobId: data.jobId,
      name: data.name || '',
      prompt: data.prompt || '',
      modelAlias: data.modelAlias || null,
      modelProfileId: data.modelProfileId || null,
      scheduleType: normalizedScheduleType,
      scheduleValue: data.scheduleValue || '',
      executionContext: data.executionContext,
      notificationRoutes: data.notificationRoutes,
      requiredTools: data.requiredTools,
      requiredMcpServers: data.requiredMcpServers,
      silent: data.silent,
      cleanupAfterMs: data.cleanupAfterMs,
      timeoutMs: data.timeoutMs,
      maxRetries: data.maxRetries,
      retryBackoffMs: data.retryBackoffMs,
      maxConsecutiveFailures: data.maxConsecutiveFailures,
      createdBy: data.createdBy,
    });

    logger.info(
      { id: result.jobId, created: result.created, sourceAgentFolder },
      'Job upserted via IPC',
    );
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    const defaultModel =
      normalizedScheduleType === 'once'
        ? getDefaultModelConfig('oneTimeJob', sourceAgentFolder)
        : getDefaultModelConfig('recurringJob', sourceAgentFolder);
    const selectedModel = result.modelAlias || defaultModel.model;
    const catalogModel = selectedModel
      ? resolveModelSelection(selectedModel)
      : undefined;
    const resolvedModel =
      (catalogModel?.ok ? catalogModel.entry : undefined) ??
      findModelByRunnerModel(result.modelAlias);
    const modelText = resolvedModel
      ? ` Model: ${resolvedModel.displayName} (${result.modelAlias ? 'explicit' : defaultModel.source}); cache: ${resolvedModel.cacheMode}; context: ${resolvedModel.contextWindowTokens} tokens.`
      : result.modelAlias
        ? ` Model: ${result.modelAlias}.`
        : ' Model: agent default for this job type.';
    const sourceJid = sourceAgentFolderJids[0] || '';
    const sourceConversation = conversationBindings[sourceJid];
    const runtimeThreadId =
      data.executionContext?.threadId ?? data.authThreadId;
    const runtimeText = ` Runtime: notifications ${runtimeThreadId ? 'this thread' : 'this conversation'}; browser ${formatBrowserProfileLabel({ agentName: sourceConversation?.name ?? sourceAgentFolder, conversationKind: sourceConversation?.conversationKind })}.`;
    const setupText = formatSetupOutcome(result.setupState);
    accept(
      (result.created
        ? `Scheduler job created (${result.jobId}).`
        : `Scheduler job updated (${result.jobId}).`) +
        modelText +
        runtimeText +
        setupText,
    );
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to upsert scheduler job.');
    logger.error({ err, sourceAgentFolder }, 'scheduler_upsert_job failed');
    reject(mapped.message, mapped.code);
  }
};

function formatSetupOutcome(
  setupState: Awaited<
    ReturnType<JobManagementService['upsertJobFromIpc']>
  >['setupState'],
): string {
  if (!setupState || setupState.state === 'ready') return '';
  const nextAction = setupState.blockers[0]?.nextAction;
  return ` Setup required: ${nextAction ?? setupState.state}.`;
}

export const schedulerCreateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_upsert_job: schedulerUpsertJobHandler,
};
