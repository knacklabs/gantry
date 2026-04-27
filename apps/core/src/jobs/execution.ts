import { randomUUID } from 'crypto';
import fs from 'fs';

import { ASSISTANT_NAME } from '../config/index.js';
import type {
  Job,
  JobExecutionMode,
  StreamingChunkOptions,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { getRuntimeControlRepository } from '../adapters/storage/postgres/runtime-store.js';
import {
  nowIso as currentIso,
  nowMs as currentTimeMs,
  toIso,
} from '../infrastructure/time/datetime.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { AgentOutput, spawnAgent } from '../runtime/agent-spawn.js';
import { createInjectedMemoryContextBlock } from '../runtime/memory-context.js';
import { notifyLinkedSessions } from './delivery.js';
import { normalizeCleanupAfterMs } from './cleanup.js';
import {
  parseTriggerRequesterSessionId,
  resolveExecutionContext,
} from './execution-context.js';
import { computeNextJobRun } from './schedule-math.js';
import { formatRunStatusMessage } from './status-formatting.js';
import { handleSystemJob, MEMORY_DREAM_SYSTEM_PROMPT } from './system-jobs.js';
import type {
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from './types.js';

const JOB_DELETION_CHECK_INTERVAL_MS = 1_000;
let schedulerStreamingGenerationCounter = 0;

export function resetSchedulerExecutionStateForTests(): void {
  schedulerStreamingGenerationCounter = 0;
}

function nextSchedulerStreamingGeneration(): number {
  return ++schedulerStreamingGenerationCounter;
}

export async function runJob(
  job: Job,
  deps: SchedulerDependencies,
  queueJid: string,
  executionModeHint?: JobExecutionMode,
  dispatch?: SchedulerDispatchPayload,
): Promise<void> {
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const currentJob = await deps.opsRepository.getJobById(job.id);
  if (!currentJob || currentJob.status !== 'active') {
    return;
  }

  const resolveAppSessionForJob = async () => {
    const control = getRuntimeControlRepository();
    if (currentJob.session_id) {
      const session = await control.getAppSessionById(currentJob.session_id);
      if (session) return session;
    }
    const appJid = currentJob.linked_sessions.find((jid) =>
      jid.startsWith('app:'),
    );
    return appJid ? control.getAppSessionByChatJid(appJid) : undefined;
  };

  const resolveAppSessionForTrigger = async (requestedBy: string) => {
    const sessionId = parseTriggerRequesterSessionId(requestedBy);
    if (!sessionId) return undefined;
    return getRuntimeControlRepository().getAppSessionById(sessionId);
  };

  const groups = deps.registeredGroups();
  const execution = resolveExecutionContext(currentJob, groups);
  if (!execution) {
    await deps.opsRepository.updateJob(currentJob.id, {
      status: 'dead_lettered',
      pause_reason: `Group scope not found: ${currentJob.group_scope}`,
      next_run: null,
    });
    deps.onSchedulerChanged?.(currentJob.id);
    return;
  }

  const scheduledFor =
    dispatch?.scheduledFor || currentJob.next_run || currentIso();
  const runId = randomUUID();
  const startedAt = currentIso();
  const timeoutMs = Math.max(30_000, currentJob.timeout_ms || 300_000);
  const executionMode: JobExecutionMode =
    (executionModeHint ?? currentJob.execution_mode) === 'serialized'
      ? 'serialized'
      : 'parallel';
  const leaseExpiresAt = toIso(currentTimeMs() + timeoutMs + 30_000);

  const claimed = await deps.opsRepository.claimDueJobRunStart({
    jobId: currentJob.id,
    runId,
    scheduledFor,
    startedAt,
    retryCount: currentJob.consecutive_failures,
    leaseExpiresAt,
    requireNextRun:
      currentJob.schedule_type !== 'manual' && !dispatch?.triggerId,
  });
  if (!claimed) {
    return;
  }
  let boundTriggerId: string | undefined;
  let eventAppSession:
    | Awaited<ReturnType<typeof resolveAppSessionForJob>>
    | undefined;
  try {
    const control = getRuntimeControlRepository();
    const boundTrigger = dispatch?.triggerId
      ? await control.bindTriggerToRun(dispatch.triggerId, runId)
      : await control.bindPendingTriggerToRun(currentJob.id, runId);
    boundTriggerId = boundTrigger?.triggerId;
    eventAppSession =
      (boundTrigger
        ? await resolveAppSessionForTrigger(boundTrigger.requestedBy)
        : undefined) ?? (await resolveAppSessionForJob());
    await control.addControlEvent({
      eventType: 'job.run.started',
      payload: JSON.stringify({
        jobId: currentJob.id,
        runId,
        scheduledFor,
      }),
      actor: 'scheduler',
      sessionId: eventAppSession?.sessionId ?? null,
      jobId: currentJob.id,
      runId,
      triggerId: boundTrigger?.triggerId ?? null,
      responseMode: eventAppSession?.defaultResponseMode,
      webhookId: eventAppSession?.defaultWebhookId,
    });
  } catch {}
  let jobDeletedDuringRun = false;
  let lastJobDeletionCheckAt = 0;
  let firstDeliveryDeletionCheckDone = false;
  const isJobDeleted = async (force = false): Promise<boolean> => {
    if (jobDeletedDuringRun) return true;
    const now = currentTimeMs();
    if (
      !force &&
      now - lastJobDeletionCheckAt < JOB_DELETION_CHECK_INTERVAL_MS
    ) {
      return false;
    }
    lastJobDeletionCheckAt = now;
    let jobStillExists: boolean;
    try {
      jobStillExists = Boolean(
        await deps.opsRepository.getJobById(currentJob.id),
      );
    } catch (err) {
      jobDeletedDuringRun = true;
      logger.debug(
        { jobId: currentJob.id, runId, err },
        'Scheduler run observed closed storage while checking job state',
      );
      return true;
    }
    if (jobStillExists) return false;
    jobDeletedDuringRun = true;
    logger.info(
      { jobId: currentJob.id, runId },
      'Scheduler job deleted while run was active',
    );
    return true;
  };
  const shouldSuppressDelivery = async (): Promise<boolean> => {
    const force = !firstDeliveryDeletionCheckDone;
    firstDeliveryDeletionCheckDone = true;
    return isJobDeleted(force);
  };
  const emitJobEvent = async (
    eventType: string,
    payload: Record<string, unknown> | null,
  ): Promise<void> => {
    if (await isJobDeleted(true)) return;
    try {
      await deps.opsRepository.addJobEvent({
        job_id: currentJob.id,
        run_id: runId,
        event_type: eventType,
        payload: payload ? JSON.stringify(payload) : null,
        created_at: currentIso(),
      });
    } catch (err) {
      logger.warn(
        { err, jobId: currentJob.id, runId, eventType },
        'Failed to write scheduler lifecycle event',
      );
    }
  };
  await emitJobEvent('job.started', {
    queue_jid: queueJid,
    execution_mode: executionMode,
    scheduled_for: scheduledFor,
    timeout_ms: timeoutMs,
  });
  let result: string | null = null;
  let error: string | null = null;
  let collectedResult = '';
  let pendingSessionId: string | undefined;
  try {
    const groupDir = resolveGroupFolderPath(execution.group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const sessionId = currentJob.session_id || undefined;
  const isMain = execution.group.isMain === true;
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
    if (!shouldDeliverToChat || !text || (await shouldSuppressDelivery()))
      return false;
    const options = currentJob.thread_id
      ? { threadId: currentJob.thread_id }
      : undefined;
    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        await (options
          ? deps.sendMessage(jid, text, options)
          : deps.sendMessage(jid, text));
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
    if (!shouldDeliverToChat || !text || (await shouldSuppressDelivery()))
      return false;
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
      (await shouldSuppressDelivery())
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
    firstDeliveryDeletionCheckDone = false;
  }

  if (!error && currentJob.prompt.startsWith('__system:')) {
    try {
      const systemResult = await handleSystemJob(
        currentJob,
        execution.group.folder,
      );
      result = JSON.stringify(systemResult);
      collectedResult = result;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    if (!error) {
      let deliveredAnyOutput = false;
      let bufferedStreamingChars = 0;
      let totalStreamingChars = 0;
      let lastStreamingEventMs = 0;
      const injectedMemoryContext = await createInjectedMemoryContextBlock({
        groupFolder: execution.group.folder,
        chatJid: execution.executionJid,
        source: 'scheduler',
        threadId: currentJob.thread_id || undefined,
      });
      const flushStreamingEvent = (force = false): void => {
        if (bufferedStreamingChars <= 0) return;
        const nowMs = currentTimeMs();
        if (!force && nowMs - lastStreamingEventMs < 1000) return;
        void emitJobEvent('job.streaming', {
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
            threadId: currentJob.thread_id || undefined,
            isMain,
            isScheduledJob: true,
            assistantName: ASSISTANT_NAME,
            script: currentJob.script || undefined,
            memoryContextBlock: injectedMemoryContext?.block,
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
        if (output.newSessionId && !(await isJobDeleted(true))) {
          pendingSessionId = output.newSessionId;
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

  const now = currentIso();
  await isJobDeleted(true);
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
    if (currentJob.schedule_type === 'manual') {
      nextRun = null;
      await deps.opsRepository.updateJob(currentJob.id, {
        status: 'active',
        next_run: null,
        last_run: now,
        consecutive_failures: retryCount,
        pause_reason: null,
        lease_run_id: null,
        lease_expires_at: null,
        ...(pendingSessionId ? { session_id: pendingSessionId } : {}),
      });
    } else {
      const exceededRetry = retryCount > currentJob.max_retries;
      const exceededConsecutive =
        retryCount >= currentJob.max_consecutive_failures;
      if (exceededRetry || exceededConsecutive) {
        runStatus = 'dead_lettered';
        nextRun = null;
        pauseReason = `Paused after ${retryCount} failures. Last error: ${error}`;
        await deps.opsRepository.updateJob(currentJob.id, {
          status: 'dead_lettered',
          next_run: null,
          last_run: now,
          consecutive_failures: retryCount,
          pause_reason: pauseReason,
          lease_run_id: null,
          lease_expires_at: null,
          ...(pendingSessionId ? { session_id: pendingSessionId } : {}),
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
        nextRun = toIso(currentTimeMs() + boundedDelay);
        await deps.opsRepository.updateJob(currentJob.id, {
          status: 'active',
          next_run: nextRun,
          last_run: now,
          consecutive_failures: retryCount,
          pause_reason: null,
          lease_run_id: null,
          lease_expires_at: null,
          ...(pendingSessionId ? { session_id: pendingSessionId } : {}),
        });
      }
    }
  } else {
    await deps.opsRepository.updateJob(currentJob.id, {
      status:
        currentJob.schedule_type === 'manual' || nextRunOnSuccess
          ? 'active'
          : 'completed',
      next_run: nextRunOnSuccess,
      last_run: now,
      consecutive_failures: 0,
      pause_reason: null,
      lease_run_id: null,
      lease_expires_at: null,
      ...(pendingSessionId ? { session_id: pendingSessionId } : {}),
    });
  }

  const resultSummary = result || collectedResult || null;
  await deps.opsRepository.completeJobRun(
    runId,
    runStatus,
    resultSummary ? resultSummary.slice(0, 500) : null,
    error ? error.slice(0, 500) : null,
  );

  await emitJobEvent(`run_${runStatus}`, {
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
    await deps.opsRepository.markJobRunNotified(runId);
  }
  await emitJobEvent(
    runStatus === 'completed' ? 'job.completed' : 'job.failed',
    {
      status: runStatus,
      next_run: nextRun,
      retry_count: retryCount,
      pause_reason: pauseReason,
      notified,
      summary,
    },
  );
  try {
    const control = getRuntimeControlRepository();
    eventAppSession = eventAppSession ?? (await resolveAppSessionForJob());
    if (boundTriggerId) {
      await control.markTriggerCompleted(
        boundTriggerId,
        runStatus === 'completed' ? 'completed' : 'failed',
      );
    }
    await control.addControlEvent({
      eventType:
        runStatus === 'completed' ? 'job.run.completed' : 'job.run.failed',
      payload: JSON.stringify({
        jobId: currentJob.id,
        runId,
        status: runStatus,
        summary,
        nextRun,
      }),
      actor: 'scheduler',
      sessionId: eventAppSession?.sessionId ?? null,
      jobId: currentJob.id,
      runId,
      triggerId: boundTriggerId ?? null,
      responseMode: eventAppSession?.defaultResponseMode,
      webhookId: eventAppSession?.defaultWebhookId,
    });
  } catch {}
  deps.onSchedulerChanged?.(currentJob.id);

  if (
    !jobDeletedDuringRun &&
    currentJob.schedule_type === 'once' &&
    (runStatus === 'completed' || runStatus === 'dead_lettered') &&
    normalizeCleanupAfterMs(currentJob.cleanup_after_ms) === 0
  ) {
    await deps.opsRepository.deleteJob(currentJob.id);
    deps.onSchedulerChanged?.(currentJob.id);
  }
}
