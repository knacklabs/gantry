import { randomUUID } from 'crypto';
import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  MEMORY_DREAMING_CRON,
  RUNTIME_MEMORY_DREAMING_ENABLED,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from '../core/config.js';
import { Job, JobExecutionMode, RegisteredGroup } from '../core/types.js';
import { logger } from '../core/logger.js';
import { runMemoryCleanupInSubprocess } from '../memory/cleanup-job.js';
import {
  getMemoryMaintenanceQueue,
  type MemoryMaintenanceQueueEnqueueResult,
} from '../memory/maintenance-queue.js';
import { MemoryService } from '../memory/memory-service.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { GroupQueue } from './group-queue.js';
import { AgentOutput, spawnAgent } from './agent-spawn.js';
import {
  addJobEvent,
  completeJobRun,
  createJobRun,
  deleteJob,
  getAllJobs,
  getJobById,
  listDueJobs,
  markJobRunNotified,
  markJobRunning,
  releaseStaleJobLeases,
  upsertJob,
  updateJob,
} from '../storage/db.js';
import { StreamingChunkOptions } from '../core/types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions?: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
    stopAliasJids?: string[],
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendStreamingChunk?: (
    jid: string,
    text: string,
    options?: StreamingChunkOptions,
  ) => Promise<boolean>;
  resetStreaming?: (jid: string) => void;
  onSchedulerChanged?: () => void;
  runAgent?: typeof spawnAgent;
}

const DEFAULT_JOB_CLEANUP_AFTER_MS = 86_400_000;
const MAX_PARALLEL_JOBS_PER_GROUP_SCOPE = 2;
let schedulerStreamingGenerationCounter = 0;
const schedulerSessions = new Map<string, string>();
const activeParallelRunsByGroupScope = new Map<string, number>();
const activeSerializedRunsByGroupScope = new Map<string, number>();
type MemoryMaintenanceQueueLike = {
  enqueueAndWait: (
    groupFolder: string,
    task: () => Promise<void>,
    dedupeKey?: string,
  ) => Promise<MemoryMaintenanceQueueEnqueueResult>;
  getPendingCount: () => number;
};
let memoryMaintenanceQueue: MemoryMaintenanceQueueLike =
  getMemoryMaintenanceQueue();

function nextSchedulerStreamingGeneration(): number {
  schedulerStreamingGenerationCounter += 1;
  return schedulerStreamingGenerationCounter;
}

function schedulerQueueJid(groupScope: string, jobId?: string): string {
  if (jobId) return `__scheduler__:${groupScope}:${jobId}`;
  return `__scheduler__:${groupScope}`;
}

function schedulerSessionKey(job: Job, mode: JobExecutionMode): string {
  if (mode === 'serialized') return `serialized:${job.group_scope}`;
  return `parallel:${job.id}`;
}

function canScheduleParallelRunForGroup(
  groupScope: string,
  queuedParallelThisTick: Map<string, number>,
  queuedSerializedThisTick: Map<string, number>,
): boolean {
  const active = activeParallelRunsByGroupScope.get(groupScope) || 0;
  const queued = queuedParallelThisTick.get(groupScope) || 0;
  const activeSerialized =
    activeSerializedRunsByGroupScope.get(groupScope) || 0;
  const queuedSerialized = queuedSerializedThisTick.get(groupScope) || 0;
  if (activeSerialized + queuedSerialized > 0) return false;
  return active + queued < MAX_PARALLEL_JOBS_PER_GROUP_SCOPE;
}

function reserveParallelRunForTick(
  groupScope: string,
  queuedParallelThisTick: Map<string, number>,
): void {
  const current = queuedParallelThisTick.get(groupScope) || 0;
  queuedParallelThisTick.set(groupScope, current + 1);
}

function acquireParallelRunSlot(groupScope: string): () => void {
  const current = activeParallelRunsByGroupScope.get(groupScope) || 0;
  activeParallelRunsByGroupScope.set(groupScope, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = activeParallelRunsByGroupScope.get(groupScope) || 0;
    if (active <= 1) {
      activeParallelRunsByGroupScope.delete(groupScope);
      return;
    }
    activeParallelRunsByGroupScope.set(groupScope, active - 1);
  };
}

function canScheduleSerializedRunForGroup(
  groupScope: string,
  queuedParallelThisTick: Map<string, number>,
  queuedSerializedThisTick: Map<string, number>,
): boolean {
  const activeParallel = activeParallelRunsByGroupScope.get(groupScope) || 0;
  const queuedParallel = queuedParallelThisTick.get(groupScope) || 0;
  if (activeParallel + queuedParallel > 0) return false;
  const activeSerialized =
    activeSerializedRunsByGroupScope.get(groupScope) || 0;
  const queuedSerialized = queuedSerializedThisTick.get(groupScope) || 0;
  return activeSerialized + queuedSerialized < 1;
}

function reserveSerializedRunForTick(
  groupScope: string,
  queuedSerializedThisTick: Map<string, number>,
): void {
  const current = queuedSerializedThisTick.get(groupScope) || 0;
  queuedSerializedThisTick.set(groupScope, current + 1);
}

function acquireSerializedRunSlot(groupScope: string): () => void {
  const current = activeSerializedRunsByGroupScope.get(groupScope) || 0;
  activeSerializedRunsByGroupScope.set(groupScope, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = activeSerializedRunsByGroupScope.get(groupScope) || 0;
    if (active <= 1) {
      activeSerializedRunsByGroupScope.delete(groupScope);
      return;
    }
    activeSerializedRunsByGroupScope.set(groupScope, active - 1);
  };
}

function pruneSchedulerSessions(jobs: Job[]): void {
  const validKeys = new Set<string>();
  for (const job of jobs) {
    const mode = normalizeExecutionMode(job.execution_mode);
    validKeys.add(schedulerSessionKey(job, mode));
  }
  for (const key of schedulerSessions.keys()) {
    if (!validKeys.has(key)) {
      schedulerSessions.delete(key);
    }
  }
}

function normalizeExecutionMode(mode: unknown): JobExecutionMode {
  return mode === 'serialized' ? 'serialized' : 'parallel';
}

function normalizeCleanupAfterMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_JOB_CLEANUP_AFTER_MS;
  }
  return Math.max(0, Math.round(value));
}

function shouldDeleteCompletedOneTimeJob(job: Job, nowMs: number): boolean {
  if (job.schedule_type !== 'once') return false;
  if (job.status !== 'completed' && job.status !== 'dead_lettered') {
    return false;
  }
  const cleanupAfterMs = normalizeCleanupAfterMs(job.cleanup_after_ms);
  if (cleanupAfterMs === 0) return true;
  const anchorIso = job.last_run || job.updated_at || job.created_at;
  const anchor = Date.parse(anchorIso);
  const anchorMs = Number.isFinite(anchor) ? anchor : nowMs;
  return nowMs - anchorMs >= cleanupAfterMs;
}

function sweepCompletedOneTimeJobs(): boolean {
  const jobs = getAllJobs();
  const nowMs = Date.now();
  let deleted = false;
  for (const job of jobs) {
    if (!shouldDeleteCompletedOneTimeJob(job, nowMs)) continue;
    deleteJob(job.id);
    deleted = true;
  }
  return deleted;
}

const MEMORY_DREAM_SYSTEM_PROMPT = '__system:memory_dream';
const MEMORY_CLEANUP_SYSTEM_PROMPT = '__system:memory_cleanup';

export function computeNextJobRun(
  job: Pick<Job, 'schedule_type' | 'schedule_value'>,
  scheduledFor: string | null,
): string | null {
  if (job.schedule_type === 'once' || job.schedule_type === 'manual') {
    return null;
  }

  if (job.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(job.schedule_value, {
      tz: TIMEZONE,
      currentDate: scheduledFor || new Date().toISOString(),
    });
    return interval.next().toISOString();
  }

  const ms = parseInt(job.schedule_value, 10);
  if (!ms || ms <= 0) {
    return new Date(Date.now() + 60_000).toISOString();
  }

  const parsedAnchor = scheduledFor ? Date.parse(scheduledFor) : Date.now();
  const anchor = Number.isFinite(parsedAnchor) ? parsedAnchor : Date.now();
  const now = Date.now();
  const steps = anchor >= now ? 1 : Math.floor((now - anchor) / ms) + 1;
  const next = anchor + steps * ms;

  if (!Number.isFinite(next) || Math.abs(next) > 8.64e15) {
    return new Date(now + 60_000).toISOString();
  }
  return new Date(next).toISOString();
}

function formatRunStatusMessage(args: {
  job: Job;
  runId: string;
  runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  summary: string;
  nextRun: string | null;
  retryCount: number;
  pauseReason?: string | null;
}): string {
  const base = [
    `Scheduler Update`,
    `job_id: ${args.job.id}`,
    `run_id: ${args.runId}`,
    `status: ${args.runStatus}`,
    `summary: ${args.summary}`,
  ];
  if (args.runStatus === 'completed') {
    base.push(`next_run: ${args.nextRun || 'none'}`);
  } else {
    base.push(`retry_count: ${args.retryCount}`);
    base.push(`retry_state: ${args.nextRun ? 'scheduled' : 'stopped'}`);
    base.push(
      `pause_state: ${args.runStatus === 'dead_lettered' ? 'paused' : 'active'}`,
    );
    if (args.pauseReason) {
      base.push(`pause_reason: ${args.pauseReason}`);
    }
  }
  return base.join('\n');
}

function resolveExecutionContext(
  job: Job,
  groups: Record<string, RegisteredGroup>,
): {
  group: RegisteredGroup;
  executionJid: string;
  stopAliasJids: string[];
} | null {
  const byFolder = Object.entries(groups).find(
    ([, group]) => group.folder === job.group_scope,
  );
  if (byFolder) {
    const stopAliasJids = Array.from(
      new Set([...(job.linked_sessions || []), byFolder[0]]),
    );
    return {
      group: byFolder[1],
      executionJid: stopAliasJids[0] || byFolder[0],
      stopAliasJids,
    };
  }

  for (const linked of job.linked_sessions) {
    const group = groups[linked];
    if (group) {
      const stopAliasJids = Array.from(
        new Set([...(job.linked_sessions || []), linked]),
      );
      return { group, executionJid: linked, stopAliasJids };
    }
  }
  return null;
}

async function notifyLinkedSessions(
  job: Job,
  text: string,
  sendMessage: SchedulerDependencies['sendMessage'],
): Promise<boolean> {
  const unique = Array.from(new Set(job.linked_sessions));
  let delivered = false;
  for (const jid of unique) {
    try {
      await sendMessage(jid, text);
      delivered = true;
    } catch (err) {
      logger.warn(
        { jobId: job.id, jid, err },
        'Failed to send scheduler status message',
      );
    }
  }
  return delivered;
}

function registerSystemJobs(deps: SchedulerDependencies): void {
  const groups = deps.registeredGroups();
  const byFolder = new Map<string, string[]>();
  const mainFolders = new Set<string>();

  for (const [jid, group] of Object.entries(groups)) {
    const linked = byFolder.get(group.folder) || [];
    linked.push(jid);
    byFolder.set(group.folder, linked);
    if (group.isMain) {
      mainFolders.add(group.folder);
    }
  }

  const nowIso = new Date().toISOString();
  if (RUNTIME_MEMORY_DREAMING_ENABLED) {
    for (const [groupFolder, linkedSessions] of byFolder.entries()) {
      const jobId = `system:dreaming:${groupFolder}`;
      const existing = getJobById(jobId);
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

      upsertJob({
        id: jobId,
        name: `Memory Dreaming (${groupFolder})`,
        prompt: MEMORY_DREAM_SYSTEM_PROMPT,
        schedule_type: 'cron',
        schedule_value: MEMORY_DREAMING_CRON,
        linked_sessions: linkedSessions,
        group_scope: groupFolder,
        created_by: 'agent',
        status: desiredStatus,
        next_run: nextRun,
        silent: false,
        timeout_ms: 300_000,
        max_retries: 1,
        retry_backoff_ms: 30_000,
        max_consecutive_failures: 3,
      });
    }
  }

  const cleanupOwnerEntry =
    [...byFolder.entries()].find(([folder]) => mainFolders.has(folder)) ||
    [...byFolder.entries()][0];
  if (!cleanupOwnerEntry) return;
  const [cleanupGroupFolder, cleanupLinkedSessions] = cleanupOwnerEntry;
  const cleanupJobId = `system:cleanup:${cleanupGroupFolder}`;
  const cleanupExisting = getJobById(cleanupJobId);
  const cleanupNextRun =
    cleanupExisting?.next_run ||
    computeNextJobRun(
      {
        schedule_type: 'cron',
        schedule_value: '0 4 * * *',
      },
      nowIso,
    );
  upsertJob({
    id: cleanupJobId,
    name: `Memory Cleanup (${cleanupGroupFolder})`,
    prompt: MEMORY_CLEANUP_SYSTEM_PROMPT,
    schedule_type: 'cron',
    schedule_value: '0 4 * * *',
    linked_sessions: cleanupLinkedSessions,
    group_scope: cleanupGroupFolder,
    created_by: 'agent',
    status: cleanupExisting?.status === 'paused' ? 'paused' : 'active',
    next_run: cleanupNextRun,
    silent: true,
    timeout_ms: 120_000,
    max_retries: 1,
    retry_backoff_ms: 15_000,
    max_consecutive_failures: 3,
  });
  for (const groupFolder of byFolder.keys()) {
    if (groupFolder === cleanupGroupFolder) continue;
    deleteJob(`system:cleanup:${groupFolder}`);
  }
}

async function handleSystemJob(
  job: Job,
  groupFolder: string,
): Promise<unknown> {
  if (job.prompt === MEMORY_DREAM_SYSTEM_PROMPT) {
    const queueResult = await memoryMaintenanceQueue.enqueueAndWait(
      groupFolder,
      async () => {
        await MemoryService.getInstance().runDreamingSweep(groupFolder);
      },
      `dream:${groupFolder}`,
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
  if (job.prompt === MEMORY_CLEANUP_SYSTEM_PROMPT) {
    const queueResult = await memoryMaintenanceQueue.enqueueAndWait(
      groupFolder,
      async () => {
        await runMemoryCleanupInSubprocess(300_000);
      },
      `cleanup:${groupFolder}`,
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

async function runJob(
  job: Job,
  deps: SchedulerDependencies,
  queueJid: string,
  executionModeHint?: JobExecutionMode,
): Promise<void> {
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const currentJob = getJobById(job.id);
  if (!currentJob || currentJob.status !== 'active') {
    return;
  }

  const groups = deps.registeredGroups();
  const execution = resolveExecutionContext(currentJob, groups);
  if (!execution) {
    updateJob(currentJob.id, {
      status: 'dead_lettered',
      pause_reason: `Group scope not found: ${currentJob.group_scope}`,
      next_run: null,
    });
    deps.onSchedulerChanged?.();
    return;
  }

  const scheduledFor = currentJob.next_run || new Date().toISOString();
  const runId = randomUUID();
  const timeoutMs = Math.max(30_000, currentJob.timeout_ms || 300_000);
  const executionMode = normalizeExecutionMode(
    executionModeHint ?? currentJob.execution_mode,
  );
  const leaseExpiresAt = new Date(
    Date.now() + timeoutMs + 30_000,
  ).toISOString();

  if (!markJobRunning(currentJob.id, runId, leaseExpiresAt)) {
    return;
  }

  const runCreated = createJobRun({
    run_id: runId,
    job_id: currentJob.id,
    scheduled_for: scheduledFor,
    started_at: new Date().toISOString(),
    ended_at: null,
    status: 'running',
    result_summary: null,
    error_summary: null,
    retry_count: currentJob.consecutive_failures,
    notified_at: null,
  });
  if (!runCreated) {
    updateJob(currentJob.id, {
      status: 'active',
      lease_run_id: null,
      lease_expires_at: null,
    });
    deps.onSchedulerChanged?.();
    return;
  }

  let jobDeletedDuringRun = false;
  const isJobDeleted = (): boolean => {
    if (jobDeletedDuringRun) return true;
    if (getJobById(currentJob.id)) return false;
    jobDeletedDuringRun = true;
    logger.info(
      { jobId: currentJob.id, runId },
      'Scheduler job deleted while run was active',
    );
    return true;
  };

  const emitJobEvent = (
    eventType: string,
    payload: Record<string, unknown> | null,
  ): void => {
    if (isJobDeleted()) return;
    try {
      addJobEvent({
        job_id: currentJob.id,
        run_id: runId,
        event_type: eventType,
        payload: payload ? JSON.stringify(payload) : null,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(
        { err, jobId: currentJob.id, runId, eventType },
        'Failed to write scheduler lifecycle event',
      );
    }
  };
  emitJobEvent('job.started', {
    queue_jid: queueJid,
    execution_mode: executionMode,
    scheduled_for: scheduledFor,
    timeout_ms: timeoutMs,
  });

  let result: string | null = null;
  let error: string | null = null;
  let collectedResult = '';

  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(execution.group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const schedulerSession = schedulerSessions.get(
    schedulerSessionKey(currentJob, executionMode),
  );
  const sessionId = schedulerSession || undefined;
  const isMain = execution.group.isMain === true;
  let ranSystemJob = false;
  const linkedSessions = Array.from(new Set(currentJob.linked_sessions));
  const shouldDeliverToChat = !currentJob.silent && linkedSessions.length > 0;
  const streamGeneration = nextSchedulerStreamingGeneration();

  const buildStreamingOptions = (args: {
    done?: boolean;
  }): StreamingChunkOptions => {
    const options: StreamingChunkOptions = {
      generation: streamGeneration,
    };
    if (currentJob.thread_id) options.threadId = currentJob.thread_id;
    if (args.done !== undefined) options.done = args.done;
    return options;
  };

  const resetDeliveryStreams = () => {
    if (!deps.resetStreaming || !shouldDeliverToChat) return;
    for (const jid of linkedSessions) {
      try {
        deps.resetStreaming(jid);
      } catch (err) {
        logger.debug(
          { err, jid, jobId: currentJob.id },
          'Failed to reset scheduler stream state',
        );
      }
    }
  };

  const deliverMessage = async (text: string): Promise<boolean> => {
    if (!shouldDeliverToChat || !text || isJobDeleted()) return false;
    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        await deps.sendMessage(jid, text);
        delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to deliver scheduler message',
        );
      }
    }
    return delivered;
  };

  const deliverStreamingChunk = async (text: string): Promise<boolean> => {
    if (!shouldDeliverToChat || !text || isJobDeleted()) return false;
    if (!deps.sendStreamingChunk) {
      return deliverMessage(text);
    }

    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        const accepted = await deps.sendStreamingChunk(
          jid,
          text,
          buildStreamingOptions({}),
        );
        if (accepted) delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to deliver scheduler stream chunk',
        );
      }
    }
    return delivered;
  };

  let streamFinalized = false;
  const finalizeStreaming = async (): Promise<boolean> => {
    if (
      !shouldDeliverToChat ||
      !deps.sendStreamingChunk ||
      streamFinalized ||
      isJobDeleted()
    ) {
      return false;
    }
    streamFinalized = true;
    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        const accepted = await deps.sendStreamingChunk(
          jid,
          '',
          buildStreamingOptions({ done: true }),
        );
        if (accepted) delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to finalize scheduler stream',
        );
      }
    }
    return delivered;
  };

  if (shouldDeliverToChat) {
    resetDeliveryStreams();
    await deliverMessage(`🔔 Scheduled task: ${currentJob.name}`);
  }

  if (!error && currentJob.prompt.startsWith('__system:')) {
    try {
      const systemResult = await handleSystemJob(
        currentJob,
        execution.group.folder,
      );
      result = JSON.stringify(systemResult);
      collectedResult = result;
      ranSystemJob = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    if (!error) {
      let deliveredAnyOutput = false;
      let bufferedStreamingChars = 0;
      let totalStreamingChars = 0;
      let lastStreamingEventMs = 0;
      const flushStreamingEvent = (force = false): void => {
        if (bufferedStreamingChars <= 0) return;
        const nowMs = Date.now();
        if (!force && nowMs - lastStreamingEventMs < 1000) return;
        emitJobEvent('job.streaming', {
          buffered_chars: bufferedStreamingChars,
          total_chars: totalStreamingChars,
        });
        bufferedStreamingChars = 0;
        lastStreamingEventMs = nowMs;
      };
      try {
        const output = await runAgentImpl(
          execution.group,
          {
            prompt: currentJob.prompt,
            model: currentJob.model || undefined,
            sessionId,
            groupFolder: execution.group.folder,
            chatJid: execution.executionJid,
            isMain,
            isScheduledJob: true,
            assistantName: ASSISTANT_NAME,
            script: currentJob.script || undefined,
          },
          (proc, containerName) =>
            deps.onProcess(
              queueJid,
              proc,
              containerName,
              execution.group.folder,
              execution.stopAliasJids,
            ),
          async (streamedOutput: AgentOutput) => {
            if (streamedOutput.result) {
              result = streamedOutput.result;
              collectedResult += streamedOutput.result;
              const chunkChars = streamedOutput.result.length;
              bufferedStreamingChars += chunkChars;
              totalStreamingChars += chunkChars;
              flushStreamingEvent();
              if (await deliverStreamingChunk(streamedOutput.result)) {
                deliveredAnyOutput = true;
              }
            }
            if (streamedOutput.status === 'success') {
              if (await finalizeStreaming()) deliveredAnyOutput = true;
            }
            if (streamedOutput.status === 'error') {
              error = streamedOutput.error || 'Unknown error';
              if (await finalizeStreaming()) deliveredAnyOutput = true;
            }
          },
          { timeoutMs },
        );
        flushStreamingEvent(true);

        if (output.status === 'error') {
          error = output.error || 'Unknown error';
        } else if (output.result) {
          result = output.result;
          if (!collectedResult) collectedResult = output.result;
        }
        if (output.newSessionId) {
          schedulerSessions.set(
            schedulerSessionKey(currentJob, executionMode),
            output.newSessionId,
          );
        }

        if (!error) {
          const fallbackText = result || collectedResult;
          if (fallbackText && !deliveredAnyOutput) {
            if (await deliverMessage(fallbackText)) {
              deliveredAnyOutput = true;
            }
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        await finalizeStreaming();
      }
    }
  }

  const now = new Date().toISOString();
  isJobDeleted();
  if (jobDeletedDuringRun) {
    result = null;
    collectedResult = '';
    error = null;
  }
  const nextRunOnSuccess = computeNextJobRun(currentJob, scheduledFor);
  let runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered' =
    'completed';
  let nextRun: string | null = nextRunOnSuccess;
  let retryCount = currentJob.consecutive_failures;
  let pauseReason: string | null = null;

  if (jobDeletedDuringRun) {
    nextRun = null;
  } else if (error) {
    retryCount += 1;
    runStatus = /timed out/i.test(error) ? 'timeout' : 'failed';
    const exceededRetry = retryCount > currentJob.max_retries;
    const exceededConsecutive =
      retryCount >= currentJob.max_consecutive_failures;
    if (exceededRetry || exceededConsecutive) {
      runStatus = 'dead_lettered';
      nextRun = null;
      pauseReason = `Paused after ${retryCount} failures. Last error: ${error}`;
      updateJob(currentJob.id, {
        status: 'dead_lettered',
        next_run: null,
        last_run: now,
        consecutive_failures: retryCount,
        pause_reason: pauseReason,
        lease_run_id: null,
        lease_expires_at: null,
      });
    } else {
      const baseBackoff = Math.max(0, currentJob.retry_backoff_ms || 0);
      const exponent = Math.max(0, retryCount - 1);
      const cappedExponent = Math.min(exponent, 30);
      const multiplier = Math.max(1, 2 ** cappedExponent);
      const rawDelay = baseBackoff * multiplier;
      const boundedDelay = Number.isFinite(rawDelay)
        ? Math.min(rawDelay, 30 * 24 * 60 * 60 * 1000)
        : 30 * 24 * 60 * 60 * 1000;
      nextRun = new Date(Date.now() + boundedDelay).toISOString();
      updateJob(currentJob.id, {
        status: 'active',
        next_run: nextRun,
        last_run: now,
        consecutive_failures: retryCount,
        pause_reason: null,
        lease_run_id: null,
        lease_expires_at: null,
      });
    }
  } else {
    updateJob(currentJob.id, {
      status: nextRunOnSuccess ? 'active' : 'completed',
      next_run: nextRunOnSuccess,
      last_run: now,
      consecutive_failures: 0,
      pause_reason: null,
      lease_run_id: null,
      lease_expires_at: null,
    });
  }

  const resultSummary = result || collectedResult || null;
  completeJobRun(
    runId,
    runStatus,
    resultSummary ? resultSummary.slice(0, 500) : null,
    error ? error.slice(0, 500) : null,
  );

  emitJobEvent(`run_${runStatus}`, {
    next_run: nextRun,
    retry_count: retryCount,
    pause_reason: pauseReason,
  });

  const summary = error
    ? error.slice(0, 240)
    : resultSummary
      ? resultSummary.slice(0, 4000)
      : 'Completed';
  if (error && currentJob.prompt === MEMORY_DREAM_SYSTEM_PROMPT) {
    logger.error(
      {
        jobId: currentJob.id,
        groupScope: currentJob.group_scope,
        runId,
        error,
      },
      'Memory dreaming system job failed',
    );
  }
  let notified = false;
  if (error && !currentJob.silent) {
    const delivered = await deliverMessage(
      `⚠️ Scheduled task failed: ${summary}`,
    );
    notified = notified || delivered;
  }
  if (runStatus !== 'completed' && !currentJob.silent) {
    const message = formatRunStatusMessage({
      job: currentJob,
      runId,
      runStatus,
      summary,
      nextRun,
      retryCount,
      pauseReason,
    });
    const delivered = await notifyLinkedSessions(
      currentJob,
      message,
      deps.sendMessage,
    );
    notified = notified || delivered;
  }
  if (notified) {
    markJobRunNotified(runId);
  }
  emitJobEvent(runStatus === 'completed' ? 'job.completed' : 'job.failed', {
    status: runStatus,
    next_run: nextRun,
    retry_count: retryCount,
    pause_reason: pauseReason,
    notified,
    summary,
  });
  deps.onSchedulerChanged?.();

  if (
    !jobDeletedDuringRun &&
    currentJob.schedule_type === 'once' &&
    (runStatus === 'completed' || runStatus === 'dead_lettered') &&
    normalizeCleanupAfterMs(currentJob.cleanup_after_ms) === 0
  ) {
    deleteJob(currentJob.id);
    deps.onSchedulerChanged?.();
  }
}

let schedulerRunning = false;

export async function runSchedulerTick(
  deps: SchedulerDependencies,
): Promise<void> {
  try {
    registerSystemJobs(deps);

    const released = releaseStaleJobLeases();
    if (released > 0) {
      logger.warn({ count: released }, 'Released stale scheduler leases');
      deps.onSchedulerChanged?.();
    }

    const dueJobs = listDueJobs();
    if (dueJobs.length > 0) {
      logger.info({ count: dueJobs.length }, 'Found due scheduler jobs');
    }

    const queuedParallelRunsThisTick = new Map<string, number>();
    const queuedSerializedRunsThisTick = new Map<string, number>();
    for (const job of dueJobs) {
      const current = getJobById(job.id);
      if (!current || current.status !== 'active') continue;
      const executionMode = normalizeExecutionMode(current.execution_mode);
      if (
        executionMode === 'parallel' &&
        !canScheduleParallelRunForGroup(
          current.group_scope,
          queuedParallelRunsThisTick,
          queuedSerializedRunsThisTick,
        )
      ) {
        continue;
      }
      if (
        executionMode === 'serialized' &&
        !canScheduleSerializedRunForGroup(
          current.group_scope,
          queuedParallelRunsThisTick,
          queuedSerializedRunsThisTick,
        )
      ) {
        continue;
      }
      const queueJid =
        executionMode === 'serialized'
          ? schedulerQueueJid(current.group_scope)
          : schedulerQueueJid(current.group_scope, current.id);
      if (executionMode === 'parallel') {
        reserveParallelRunForTick(
          current.group_scope,
          queuedParallelRunsThisTick,
        );
      }
      if (executionMode === 'serialized') {
        reserveSerializedRunForTick(
          current.group_scope,
          queuedSerializedRunsThisTick,
        );
      }
      deps.queue.enqueueTask(queueJid, current.id, () =>
        (async () => {
          const releaseSlot =
            executionMode === 'parallel'
              ? acquireParallelRunSlot(current.group_scope)
              : acquireSerializedRunSlot(current.group_scope);
          try {
            await runJob(current, deps, queueJid, executionMode);
          } finally {
            releaseSlot?.();
          }
        })(),
      );
    }

    const removed = sweepCompletedOneTimeJobs();
    if (removed) {
      deps.onSchedulerChanged?.();
    }

    pruneSchedulerSessions(getAllJobs());
  } catch (err) {
    logger.error({ err }, 'Error in scheduler loop');
  }
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    await runSchedulerTick(deps);
    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  schedulerStreamingGenerationCounter = 0;
  schedulerSessions.clear();
  activeParallelRunsByGroupScope.clear();
  activeSerializedRunsByGroupScope.clear();
  memoryMaintenanceQueue = getMemoryMaintenanceQueue();
}

/** @internal - for tests only. */
export function _setMemoryMaintenanceQueueForTests(
  queue: MemoryMaintenanceQueueLike | null,
): void {
  memoryMaintenanceQueue = queue ?? getMemoryMaintenanceQueue();
}
