import { createHash } from 'node:crypto';

import {
  MEMORY_DREAMING_CRON,
  RUNTIME_MEMORY_DREAMING_ENABLED,
} from '../config/index.js';
import type { Job } from '../domain/types.js';
import {
  getMemoryMaintenanceQueue,
  type MemoryMaintenanceQueueEnqueueResult,
} from '../memory/maintenance-queue.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import { resolveScopedMemorySubject } from '../memory/app-memory-subject-resolver.js';
import { AppMemoryService } from '../memory/app-memory-service.js';
import { nowIso as currentIso } from '../infrastructure/time/datetime.js';
import {
  getSystemJobRegistrationSignature,
  setSystemJobRegistrationSignature,
} from './system-registration-cache.js';
import { computeNextJobRun } from './schedule-math.js';
import { buildCanonicalJobLifecycleTarget } from './job-notification-routes.js';
import type { SchedulerDependencies } from './types.js';

export const MEMORY_DREAM_SYSTEM_PROMPT = '__system:memory_dream';

type MemoryMaintenanceQueueLike = {
  enqueueAndWait: (
    folder: string,
    task: () => Promise<void>,
    dedupeKey?: string,
  ) => Promise<MemoryMaintenanceQueueEnqueueResult>;
  getPendingCount: () => number;
};

let memoryMaintenanceQueue: MemoryMaintenanceQueueLike =
  getMemoryMaintenanceQueue();

function routeDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function systemDreamingJobId(input: { folder: string; jid: string }): string {
  return `system:dreaming:${input.folder}:${routeDigest(input.jid)}`;
}

async function deleteObsoletePerFolderDreamingJobs(
  deps: SchedulerDependencies,
): Promise<void> {
  const legacyPrefix = 'system:dreaming:';
  const jobs = await deps.opsRepository.getAllJobs();
  for (const job of jobs) {
    if (!job.id.startsWith(legacyPrefix)) continue;
    const suffix = job.id.slice(legacyPrefix.length);
    if (!suffix || suffix.includes(':')) continue;
    await deps.opsRepository.deleteJob(job.id);
  }
}

export async function registerSystemJobs(
  deps: SchedulerDependencies,
): Promise<void> {
  const groups = deps.conversationRoutes();
  const registrations = Object.entries(groups).map(([jid, group]) => ({
    jid,
    group,
  }));

  const registrationSignature = JSON.stringify({
    dreamingEnabled: RUNTIME_MEMORY_DREAMING_ENABLED,
    dreamingCron: MEMORY_DREAMING_CRON,
    routes: registrations
      .map(({ jid, group }) => [
        group.folder,
        jid,
        group.conversationKind ?? 'channel',
      ])
      .sort(([leftFolder, leftJid], [rightFolder, rightJid]) =>
        `${leftFolder}:${leftJid}`.localeCompare(`${rightFolder}:${rightJid}`),
      ),
  });
  if (
    getSystemJobRegistrationSignature(deps.opsRepository) ===
    registrationSignature
  ) {
    return;
  }

  const nowIso = currentIso();
  if (RUNTIME_MEMORY_DREAMING_ENABLED) {
    await deleteObsoletePerFolderDreamingJobs(deps);
    for (const { jid, group } of registrations) {
      const jobId = systemDreamingJobId({ folder: group.folder, jid });
      const existing = await deps.opsRepository.getJobById(jobId);
      if (existing?.status === 'dead_lettered') {
        continue;
      }
      const computedNextRun = computeNextJobRun(
        {
          schedule_type: 'cron',
          schedule_value: MEMORY_DREAMING_CRON,
        },
        nowIso,
      );
      const nextRun = existing?.next_run || computedNextRun;
      const desiredStatus = existing?.status === 'paused' ? 'paused' : 'active';
      const target = buildCanonicalJobLifecycleTarget({
        conversationJid: jid,
        groupScope: group.folder,
        threadId: null,
        label: 'primary',
      });

      const systemJob = {
        id: jobId,
        name: `Memory Dreaming (${group.folder} ${jid})`,
        prompt: MEMORY_DREAM_SYSTEM_PROMPT,
        schedule_type: 'cron',
        schedule_value: MEMORY_DREAMING_CRON,
        session_id: null,
        group_scope: group.folder,
        created_by: 'agent',
        status: desiredStatus,
        next_run: nextRun,
        silent: false,
        timeout_ms: 300_000,
        max_retries: 1,
        retry_backoff_ms: 30_000,
        max_consecutive_failures: 3,
        execution_context: target.executionContext,
        notification_routes: target.notificationRoutes,
      };
      await deps.opsRepository.upsertJob(
        systemJob as unknown as Parameters<
          SchedulerDependencies['opsRepository']['upsertJob']
        >[0],
      );
    }
  }
  setSystemJobRegistrationSignature(deps.opsRepository, registrationSignature);
}

export async function handleSystemJob(
  job: Job,
  context: {
    folder: string;
    conversationId?: string;
    conversationKind?: 'dm' | 'channel';
    userId?: string;
    threadId?: string | null;
  },
): Promise<unknown> {
  if (job.prompt === MEMORY_DREAM_SYSTEM_PROMPT) {
    const defaultScope = context.conversationKind === 'dm' ? 'user' : 'group';
    const { subject } = resolveScopedMemorySubject({
      appId: DEFAULT_MEMORY_APP_ID,
      agentId: memoryAgentIdForGroupFolder(context.folder),
      groupId: context.folder,
      conversationId: context.conversationId,
      userId: context.userId,
      threadId: context.threadId || undefined,
      defaultScope,
    });
    const queueResult = await memoryMaintenanceQueue.enqueueAndWait(
      context.folder,
      async () => {
        await AppMemoryService.getInstance().triggerDreaming({
          ...subject,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          phase: 'all',
        });
      },
      `dream:${subject.subjectType}:${subject.subjectId}${subject.threadId ? `:thread:${subject.threadId}` : ''}`,
    );
    if (!queueResult.queued) {
      if (queueResult.reason === 'full') {
        throw new Error('memory maintenance queue full');
      }
      if (queueResult.reason === 'invalid') {
        throw new Error('invalid memory maintenance group');
      }
    }
    return {
      queued: queueResult.queued,
      pending: memoryMaintenanceQueue.getPendingCount(),
      deduped: queueResult.deduped,
    };
  }
  throw new Error(`Unknown system job: ${job.prompt}`);
}

export function resetSystemJobStateForTests(): void {
  memoryMaintenanceQueue = getMemoryMaintenanceQueue();
}

export function _setMemoryMaintenanceQueueForTests(queue: unknown): void {
  memoryMaintenanceQueue =
    (queue as MemoryMaintenanceQueueLike | null) ?? getMemoryMaintenanceQueue();
}
