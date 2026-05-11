import { randomUUID } from 'node:crypto';

import { JobManagementService } from '../application/jobs/job-management-service.js';
import type { JobExtraToolApprovalRequest } from '../application/jobs/job-management-types.js';
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
import { resolveSchedulerApprovalTarget } from './ipc-scheduler-approval-target.js';
import { schedulerAccessFromContext } from './ipc-scheduler-access.js';

function makeJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    control: context.deps.getJobControl?.(),
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
    toolRepository: context.deps.getToolRepository?.(),
    approveJobExtraTools: (request) =>
      requestJobExtraToolApproval(context, request),
  });
}

async function requestJobExtraToolApproval(
  context: TaskContext,
  request: JobExtraToolApprovalRequest,
): Promise<{ approved: boolean; reason?: string }> {
  const approvalTarget = resolveSchedulerApprovalTarget(context);
  if (!approvalTarget.ok) {
    return { approved: false, reason: approvalTarget.reason };
  }
  const decision = await context.deps.requestPermissionApproval({
    requestId: `job-tools-${randomUUID()}`,
    appId: request.target.appId as never,
    agentId: request.target.agentId as never,
    sourceAgentFolder: context.sourceAgentFolder,
    targetJid: approvalTarget.targetJid,
    threadId: context.data.authThreadId,
    decisionPolicy: 'same_channel',
    toolName: 'scheduler_job_tools',
    displayName: 'Autonomous job tools',
    title: 'Approve job-scoped autonomous tools',
    description:
      'stored on this job only; inherited agent grants are shown separately.',
    decisionReason: `${request.operation === 'create' ? 'Create' : 'Update'} scheduler job ${request.jobName} with job-scoped extra tools.`,
    toolInput: {
      jobId: request.jobId,
      target: request.target,
      inheritedTools: request.inheritedTools,
      existingJobExtraTools: request.existingJobExtraTools,
      requestedJobExtraTools: request.requestedJobExtraTools,
      extrasBeyondInherited: request.extrasBeyondInherited,
      persistence: 'target_json.capabilityPolicy.allowedTools',
    },
    decisionOptions: ['allow_job_policy', 'cancel'],
  });
  return { approved: decision.approved, reason: decision.reason };
}

function scheduleType(raw: unknown): JobScheduleType | undefined {
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
  const { accept, reject } = createTaskResponder(
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
      silent: data.silent,
      cleanupAfterMs: data.cleanupAfterMs,
      timeoutMs: data.timeoutMs,
      maxRetries: data.maxRetries,
      retryBackoffMs: data.retryBackoffMs,
      maxConsecutiveFailures: data.maxConsecutiveFailures,
      executionMode: data.executionMode,
      serialize: data.serialize,
      createdBy: data.createdBy,
      allowedTools: data.allowedTools,
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
    accept(
      (result.created
        ? `Scheduler job created (${result.jobId}).`
        : `Scheduler job updated (${result.jobId}).`) +
        modelText +
        runtimeText,
    );
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to upsert scheduler job.');
    logger.error({ err, sourceAgentFolder }, 'scheduler_upsert_job failed');
    reject(mapped.message, mapped.code);
  }
};

export const schedulerCreateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_upsert_job: schedulerUpsertJobHandler,
};
