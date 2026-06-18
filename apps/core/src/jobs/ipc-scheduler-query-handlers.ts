import { JobManagementService } from '../application/jobs/job-management-service.js';
import {
  buildJobListVisibilityMetadata,
  buildJobVisibilityMetadata,
  type JobVisibilityMetadata,
} from '../application/jobs/job-visibility-metadata.js';
import { logger } from '../infrastructure/logging/logger.js';
import { TaskContext, TaskHandler } from './ipc-types.js';
import { mapApplicationError } from './ipc-application-error.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { schedulerAccessFromContext } from './ipc-scheduler-access.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';
import { resolveCanonicalAppSessionForOrigin } from '../application/jobs/job-management-helpers.js';
import { normalizeOptional } from '../application/jobs/job-management-access.js';
import { appIdFromConversationJid } from '../shared/app-conversation-jid.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';

const SCHEDULER_WAIT_MIN_TIMEOUT_MS = 1_000;
const SCHEDULER_WAIT_MAX_TIMEOUT_MS = 300_000;
const SCHEDULER_WAIT_POLL_MS = 1_000;

function makeJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    control: context.deps.getJobControl?.(),
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
    toolRepository: context.deps.getToolRepository?.(),
    skillRepository: context.deps.getSkillRepository?.(),
    mcpServerRepository: context.deps.getMcpServerRepository?.(),
    capabilitySecretRepository: context.deps.getCapabilitySecretRepository?.(),
    getCredentialBroker: context.deps.getCredentialBroker,
    getBrowserStatus: context.deps.getBrowserStatus,
  });
}

async function resolveMetadataAppId(
  context: TaskContext,
): Promise<string | undefined> {
  const access = schedulerAccessFromContext(context);
  if (!appIdFromConversationJid(access.originConversationJid)) {
    return undefined;
  }
  const { canonicalSession } = await resolveCanonicalAppSessionForOrigin({
    access,
    control: context.deps.getJobControl?.(),
  });
  return canonicalSession?.appId;
}

function normalizeSchedulerWaitTimeoutMs(value: unknown): number {
  const raw =
    typeof value === 'number' && Number.isFinite(value) ? value : 30_000;
  return Math.max(
    SCHEDULER_WAIT_MIN_TIMEOUT_MS,
    Math.min(raw, SCHEDULER_WAIT_MAX_TIMEOUT_MS),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function schedulerEventFilters(data: TaskContext['data']): {
  jobId?: string;
  runId?: string;
  eventType?: string;
  since?: string;
  sinceId?: number;
  limit?: number;
} {
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  const runId = toTrimmedString(data.runId, { maxLen: 128 });
  const eventType = toTrimmedString(data.eventType, { maxLen: 128 });
  return {
    jobId: jobId || undefined,
    runId: runId || undefined,
    eventType: eventType || undefined,
    since: toTrimmedString(data.since, { maxLen: 128 }) || undefined,
    sinceId:
      typeof data.sinceId === 'number' && Number.isFinite(data.sinceId)
        ? Math.max(0, Math.floor(data.sinceId))
        : undefined,
    limit: data.limit,
  };
}

const schedulerGetJobHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_get_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    const service = makeJobService(context);
    const access = schedulerAccessFromContext(context);
    const result = await service.getJob({
      jobId,
      access,
    });
    const metadataAppId = await resolveMetadataAppId(context);
    const data = result.job
      ? {
          job: {
            ...result.job,
            visibility: publicJobVisibility(
              await buildJobVisibilityMetadata({
                job: result.job,
                appId: metadataAppId,
                ops: context.deps.opsRepository,
                toolRepository: context.deps.getToolRepository?.(),
                skillRepository: context.deps.getSkillRepository?.(),
              }),
            ),
          },
        }
      : result;
    acceptData(
      result.job ? `Loaded scheduler job (${jobId}).` : 'Job not found.',
      data,
    );
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error({ err, sourceAgentFolder, jobId }, 'scheduler_get_job failed');
    reject(mapped.message, mapped.code);
  }
};

const schedulerListJobsHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  try {
    const service = makeJobService(context);
    const metadataAppId = await resolveMetadataAppId(context);
    const result = await service.listJobs({
      access: schedulerAccessFromContext(context),
      statuses: Array.isArray(data.statuses) ? data.statuses : undefined,
      kind:
        data.kind === 'manual' ||
        data.kind === 'once' ||
        data.kind === 'recurring'
          ? data.kind
          : undefined,
      limit: data.limit,
    });
    const metadata = await buildJobListVisibilityMetadata({
      jobs: result.jobs,
      ops: context.deps.opsRepository,
      appId: metadataAppId,
      toolRepository: context.deps.getToolRepository?.(),
      skillRepository: context.deps.getSkillRepository?.(),
    });
    acceptData(`Listed ${result.jobs.length} scheduler job(s).`, {
      jobs: result.jobs.map(({ prompt: _prompt, ...job }) => {
        const jobMetadata = metadata.get(job.id);
        if (!jobMetadata) {
          throw new Error(`Missing visibility metadata for job ${job.id}`);
        }
        return {
          ...job,
          prompt_preview: jobMetadata.promptPreview,
          visibility: publicJobVisibility(jobMetadata),
        };
      }),
    });
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error({ err, sourceAgentFolder }, 'scheduler_list_jobs failed');
    reject(mapped.message, mapped.code);
  }
};

function publicJobVisibility(metadata: JobVisibilityMetadata) {
  return {
    executionContext: metadata.executionContext,
    notificationRoutes: metadata.notificationRoutes,
    target: metadata.target,
    ownerLabel: metadata.ownerLabel,
    deliveryLabel: metadata.deliveryLabel,
    setupLabel: metadata.setupLabel,
    nextActionLabel: metadata.nextActionLabel,
    promptPreview: metadata.promptPreview,
    fullPrompt: metadata.fullPrompt,
    toolAccess: metadata.toolAccess,
    capabilityRequirements: metadata.capabilityRequirements,
    toolAccessRequirements: metadata.toolAccessRequirements,
    requiredMcpServers: metadata.requiredMcpServers,
    setup: metadata.setup,
    recovery: metadata.recovery,
    health: metadata.health,
    recentRunErrors: metadata.recentRunErrors,
    staleness: metadata.staleness,
  };
}

const schedulerListRunsHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  try {
    const result = await makeJobService(context).listJobRuns({
      access: schedulerAccessFromContext(context),
      jobId: jobId || undefined,
      limit: data.limit,
    });
    acceptData(`Listed ${result.runs.length} scheduler run(s).`, result);
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error(
      { err, sourceAgentFolder, jobId: jobId || undefined },
      'scheduler_list_runs failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerListEventsHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const filters = schedulerEventFilters(data);
  try {
    const result = await makeJobService(context).listJobEvents({
      access: schedulerAccessFromContext(context),
      ...filters,
    });
    acceptData(`Listed ${result.events.length} scheduler event(s).`, result);
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error(
      {
        err,
        sourceAgentFolder,
        jobId: filters.jobId,
        runId: filters.runId,
        eventType: filters.eventType,
      },
      'scheduler_list_events failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerWaitForEventsHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const filters = schedulerEventFilters(data);
  const timeoutMs = normalizeSchedulerWaitTimeoutMs(data.timeoutMs);
  const deadline = currentTimeMs() + timeoutMs;
  try {
    while (true) {
      const result = await makeJobService(context).listJobEvents({
        access: schedulerAccessFromContext(context),
        ...filters,
      });
      if (result.events.length > 0 || currentTimeMs() >= deadline) {
        acceptData(
          `Listed ${result.events.length} scheduler event(s).`,
          result,
        );
        return;
      }
      const remainingMs = Math.max(0, deadline - currentTimeMs());
      await delay(Math.min(SCHEDULER_WAIT_POLL_MS, remainingMs));
    }
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error(
      {
        err,
        sourceAgentFolder,
        jobId: filters.jobId,
        runId: filters.runId,
        eventType: filters.eventType,
      },
      'scheduler_wait_for_events failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerGetDeadLetterHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  try {
    const result = await makeJobService(context).listDeadLetterRuns({
      access: schedulerAccessFromContext(context),
      limit: data.limit,
    });
    acceptData(
      `Listed ${result.deadLetterRuns.length} dead-letter run(s).`,
      result,
    );
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error(
      { err, sourceAgentFolder },
      'scheduler_get_dead_letter failed',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerListNotificationTargetsHandler: TaskHandler = async (
  context,
) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  try {
    const access = schedulerAccessFromContext(context);
    const authThreadId = normalizeOptional(access.authThreadId) ?? null;
    const originConversationJid = access.originConversationJid;
    const originConversation =
      access.conversationBindings[originConversationJid] ?? null;
    const originIsDm = originConversation?.conversationKind === 'dm';

    const targets: Array<Record<string, unknown>> = [
      {
        shortcut: 'here',
        label: authThreadId
          ? 'Current thread/topic in this conversation'
          : 'Current conversation',
        executionContext: {
          conversationJid: originConversationJid,
          threadId: authThreadId,
          workspaceKey: access.sourceAgentFolder,
        },
        notificationRoutes: [
          {
            conversationJid: originConversationJid,
            threadId: authThreadId,
            label: 'primary',
          },
        ],
      },
    ];
    if (authThreadId) {
      targets.push({
        shortcut: 'this_thread',
        label: 'Current thread/topic',
        executionContext: {
          conversationJid: originConversationJid,
          threadId: authThreadId,
          workspaceKey: access.sourceAgentFolder,
        },
        notificationRoutes: [
          {
            conversationJid: originConversationJid,
            threadId: authThreadId,
            label: 'this_thread',
          },
        ],
      });
      targets.push({
        shortcut: 'this_topic',
        label: 'Current topic',
        executionContext: {
          conversationJid: originConversationJid,
          threadId: authThreadId,
          workspaceKey: access.sourceAgentFolder,
        },
        notificationRoutes: [
          {
            conversationJid: originConversationJid,
            threadId: authThreadId,
            label: 'this_thread',
          },
        ],
      });
    }
    if (originIsDm) {
      targets.push({
        shortcut: 'me_dm',
        label: 'Direct message conversation',
        executionContext: {
          conversationJid: originConversationJid,
          threadId: null,
          workspaceKey: access.sourceAgentFolder,
        },
        notificationRoutes: [
          {
            conversationJid: originConversationJid,
            threadId: null,
            label: 'me_dm',
          },
        ],
      });
    }

    acceptData(`Listed ${targets.length} scheduler notification target(s).`, {
      targets,
    });
  } catch (err) {
    const mapped = mapApplicationError(
      err,
      'Failed to list scheduler notification targets.',
    );
    logger.error(
      { err, sourceAgentFolder },
      'scheduler_list_notification_targets failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

export const schedulerQueryTaskHandlers: Record<string, TaskHandler> = {
  scheduler_get_job: schedulerGetJobHandler,
  scheduler_list_jobs: schedulerListJobsHandler,
  scheduler_list_notification_targets: schedulerListNotificationTargetsHandler,
  scheduler_list_runs: schedulerListRunsHandler,
  scheduler_list_events: schedulerListEventsHandler,
  scheduler_wait_for_events: schedulerWaitForEventsHandler,
  scheduler_get_dead_letter: schedulerGetDeadLetterHandler,
};
