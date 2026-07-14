import { logger } from '../infrastructure/logging/logger.js';
import type { SessionCommandDeps } from './session-commands.js';

type CompactionProviderSession = {
  providerSessionId: string;
  externalSessionId: string;
};

export const COMPACTION_QUEUED_MESSAGE =
  "Compaction queued. You can keep messaging me; I'll use the compacted context when it's ready.";
export const COMPACTION_ALREADY_RUNNING_MESSAGE =
  'Compaction is already running or queued. You can keep messaging me.';

const COMPACTION_READY_MESSAGE =
  "Compaction ready. I'll use the compacted context and updated memory on your next message.";
const COMPACTION_DEGRADED_MESSAGE =
  "Compaction ready, but memory extraction did not finish. I'll use compacted context and existing memory.";
const COMPACTION_FRESH_CHECKPOINT_READY_MESSAGE =
  "Compaction ready. I'll use updated memory and a fresh provider context on your next message.";
const COMPACTION_FRESH_CHECKPOINT_DEGRADED_MESSAGE =
  "Compaction ready, but memory extraction did not finish. I'll use a fresh provider context and existing memory.";
const COMPACTION_FAILED_MESSAGE =
  "Compaction did not finish. I'll keep using current continuity and memory.";
const COMPACTION_FAILED_EVENT_SUMMARY = 'Session compaction did not finish.';
const COMPACTION_TASK_HEARTBEAT_MS = 60_000;

const queuedCompactions = new Set<string>();

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

async function publishSessionCompactionEvent(
  groupName: string,
  deps: SessionCommandDeps,
  state: 'queued' | 'running' | 'ready' | 'degraded' | 'failed' | 'timeout',
  details?: Parameters<
    NonNullable<SessionCommandDeps['publishSessionCompactionEvent']>
  >[1],
) {
  try {
    await deps.publishSessionCompactionEvent?.(state, details);
  } catch (err) {
    logger.warn(
      { group: groupName, err, state },
      'Failed to publish session compaction runtime event',
    );
  }
}

export function hasQueuedSessionCompaction(scopeKey: string): boolean {
  return queuedCompactions.has(scopeKey);
}

export async function queueSessionCompaction(
  groupName: string,
  deps: SessionCommandDeps,
  baseCursor?: string,
): Promise<'queued' | 'already_running'> {
  const dedupeKey = deps.compactionScopeKey?.trim() || groupName;
  const admittedTask = await deps.admitSessionCompactionTask?.();
  if (admittedTask && !admittedTask.admitted) return 'already_running';
  if (!admittedTask && queuedCompactions.has(dedupeKey)) {
    return 'already_running';
  }
  queuedCompactions.add(dedupeKey);
  let locked: CompactionProviderSession | undefined;
  let task = admittedTask?.task;
  if (admittedTask) {
    await publishSessionCompactionEvent(groupName, deps, 'queued', { task });
  }
  if (!admittedTask && deps.beginSessionCompaction) {
    locked = await deps.beginSessionCompaction({ baseCursor });
    if (!locked) {
      queuedCompactions.delete(dedupeKey);
      return 'already_running';
    }
    await publishSessionCompactionEvent(groupName, deps, 'queued', {});
  }
  void (async () => {
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (admittedTask) {
      locked = await deps.beginSessionCompaction?.({ baseCursor });
      if (!locked) {
        await deps.finishSessionCompactionTask?.(task, 'failed');
        await publishSessionCompactionEvent(groupName, deps, 'failed', {
          task,
          errorSummary: 'Maintenance lock unavailable.',
        });
        await deps.sendMessage(COMPACTION_FAILED_MESSAGE);
        return;
      }
      task =
        (await deps.markSessionCompactionTaskRunning?.(
          admittedTask.task,
          locked,
        )) ?? admittedTask.task;
      await publishSessionCompactionEvent(groupName, deps, 'running', {
        task,
      });
      if (deps.heartbeatSessionCompactionTask) {
        heartbeatTimer = setInterval(() => {
          void deps
            .heartbeatSessionCompactionTask?.(task)
            .then((next) => {
              if (next) task = next;
            })
            .catch(() => undefined);
        }, COMPACTION_TASK_HEARTBEAT_MS);
        heartbeatTimer.unref?.();
      }
    }
    try {
      let compactError: string | undefined;
      if (!locked) {
        await deps.finishSessionCompactionTask?.(task, 'failed');
        await publishSessionCompactionEvent(groupName, deps, 'failed', {
          task,
          errorSummary: 'Maintenance lock unavailable.',
        });
        await deps.sendMessage(COMPACTION_FAILED_MESSAGE);
        return;
      }
      const strategy =
        (await deps.getSessionCompactionStrategy?.()) ?? 'provider_compaction';
      if (strategy === 'fresh_checkpoint') {
        const archiveOutcome =
          await deps.archiveCurrentSession('manual-compact');
        await deps.onSessionArchived?.('manual-compact');
        await deps.finishSessionCompaction?.(locked, 'expired');
        const outcome =
          archiveOutcome && archiveOutcome.memory === 'degraded'
            ? 'degraded'
            : 'ready';
        await deps.finishSessionCompactionTask?.(task, outcome);
        await publishSessionCompactionEvent(groupName, deps, outcome, {
          task,
          strategy,
        });
        await deps.sendMessage(
          outcome === 'degraded'
            ? COMPACTION_FRESH_CHECKPOINT_DEGRADED_MESSAGE
            : COMPACTION_FRESH_CHECKPOINT_READY_MESSAGE,
        );
        return;
      }
      const compactResult = await deps.runSessionCompaction(
        async (result) => {
          if (result.status !== 'error') return;
          compactError = resultToText(result.result) || 'Compact failed.';
        },
        { maintenanceProviderSession: locked },
      );

      if (compactResult !== 'success' || compactError) {
        await deps.finishSessionCompactionTask?.(task, 'failed');
        await deps.finishSessionCompaction?.(locked, 'active');
        await publishSessionCompactionEvent(groupName, deps, 'failed', {
          task,
          strategy,
          errorSummary: COMPACTION_FAILED_EVENT_SUMMARY,
        });
        await deps.sendMessage(COMPACTION_FAILED_MESSAGE);
        return;
      }

      const archiveOutcome = await deps.archiveCurrentSession('manual-compact');
      await deps.onSessionArchived?.('manual-compact');
      await deps.finishSessionCompaction?.(locked, 'ready');
      await deps.finishSessionCompactionTask?.(
        task,
        archiveOutcome && archiveOutcome.memory === 'degraded'
          ? 'degraded'
          : 'ready',
      );
      await publishSessionCompactionEvent(
        groupName,
        deps,
        archiveOutcome && archiveOutcome.memory === 'degraded'
          ? 'degraded'
          : 'ready',
        {
          task,
          strategy,
        },
      );
      await deps.sendMessage(
        archiveOutcome && archiveOutcome.memory === 'degraded'
          ? COMPACTION_DEGRADED_MESSAGE
          : COMPACTION_READY_MESSAGE,
      );
    } catch {
      await deps.finishSessionCompactionTask?.(task, 'failed');
      await deps.finishSessionCompaction?.(locked, 'active');
      await publishSessionCompactionEvent(groupName, deps, 'failed', {
        task,
      });
      await deps.sendMessage(COMPACTION_FAILED_MESSAGE);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  })()
    .catch((err) => {
      logger.error({ group: groupName, err }, 'Background compaction crashed');
      void Promise.all([
        deps.finishSessionCompactionTask?.(task, 'failed'),
        deps.finishSessionCompaction?.(locked, 'active'),
        publishSessionCompactionEvent(groupName, deps, 'failed', {
          task,
        }),
        deps.sendMessage(COMPACTION_FAILED_MESSAGE),
      ]).catch(() => undefined);
    })
    .finally(() => {
      queuedCompactions.delete(dedupeKey);
    });
  return 'queued';
}
