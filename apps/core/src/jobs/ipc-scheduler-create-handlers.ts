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

function makeJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
  });
}

function scheduleType(raw: unknown): JobScheduleType | undefined {
  return raw === 'cron' || raw === 'interval' || raw === 'once'
    ? raw
    : undefined;
}

const schedulerUpsertJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, registeredGroups, sourceGroupJids } =
    context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );

  if (typeof data.script === 'string' && data.script.trim().length > 0) {
    logger.warn(
      { sourceGroup, name: data.name },
      'Rejected scheduler_upsert_job with script payload from IPC',
    );
    reject(
      'script mutation is not allowed for scheduler_upsert_job.',
      'forbidden',
    );
    return;
  }

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
    const result = await makeJobService(context).upsertJobFromIpc({
      access: {
        sourceGroup,
        isMain,
        conversationBindings: registeredGroups,
        sourceGroupJids,
        authThreadId: data.authThreadId,
      },
      jobId: data.jobId,
      name: data.name || '',
      prompt: data.prompt || '',
      modelAlias: data.modelAlias || null,
      modelProfileId: data.modelProfileId || null,
      scheduleType: normalizedScheduleType,
      scheduleValue: data.scheduleValue || '',
      linkedSessions: data.linkedSessions,
      deliverTo: data.deliverTo,
      threadId: data.threadId ?? undefined,
      silent: data.silent,
      cleanupAfterMs: data.cleanupAfterMs,
      timeoutMs: data.timeoutMs,
      maxRetries: data.maxRetries,
      retryBackoffMs: data.retryBackoffMs,
      maxConsecutiveFailures: data.maxConsecutiveFailures,
      executionMode: data.executionMode,
      serialize: data.serialize,
      groupScope: data.groupScope,
      createdBy: data.createdBy,
    });

    logger.info(
      { id: result.jobId, created: result.created, sourceGroup },
      'Job upserted via IPC',
    );
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    const defaultModel =
      normalizedScheduleType === 'once'
        ? getDefaultModelConfig('oneTimeJob', sourceGroup)
        : getDefaultModelConfig('recurringJob', sourceGroup);
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
    const sourceJid = sourceGroupJids[0] || '';
    const sourceConversation = registeredGroups[sourceJid];
    const runtimeText = ` Runtime: notifications ${data.threadId || data.authThreadId ? 'this thread' : 'this conversation'}; browser ${formatBrowserProfileLabel({ agentName: sourceConversation?.name ?? sourceGroup, conversationKind: sourceConversation?.conversationKind })}.`;
    accept(
      (result.created
        ? `Scheduler job created (${result.jobId}).`
        : `Scheduler job updated (${result.jobId}).`) +
        modelText +
        runtimeText,
    );
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to upsert scheduler job.');
    logger.error({ err, sourceGroup }, 'scheduler_upsert_job failed');
    reject(mapped.message, mapped.code);
  }
};

export const schedulerCreateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_upsert_job: schedulerUpsertJobHandler,
};
