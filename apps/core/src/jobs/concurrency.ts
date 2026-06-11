import { randomUUID } from 'node:crypto';

import type { RunSlotRepository } from '../domain/ports/worker-coordination.js';
import { sleep } from '../shared/time/datetime.js';

const DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP = 1;
const RUN_SLOT_RETRY_DELAY_MS = 100;
// Slots are leased, not held: a crashed worker's slot expires and is
// reclaimed cluster-wide, so renewal must outpace the TTL while a run lives.
const RUN_SLOT_TTL_MS = 15 * 60_000;
const RUN_SLOT_RENEW_INTERVAL_MS = 5 * 60_000;

interface RunSlotBackend {
  repository: RunSlotRepository;
  workerInstanceId: string;
  warn?: (context: Record<string, unknown>, message: string) => void;
}

let backend: RunSlotBackend | null = null;

export function configureRunSlotBackend(next: RunSlotBackend | null): void {
  backend = next;
}

export async function acquireRunSlot(
  workspaceKey: string,
  maxParallelRuns = DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP,
): Promise<() => void> {
  for (;;) {
    const release = await tryAcquireRunSlot(workspaceKey, maxParallelRuns);
    if (release) return release;
    await sleep(RUN_SLOT_RETRY_DELAY_MS);
  }
}

export async function tryAcquireRunSlot(
  workspaceKey: string,
  maxParallelRuns = DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP,
): Promise<(() => void) | null> {
  const active = backend;
  if (!active) {
    throw new Error(
      'Run slot backend is not configured; scheduler startup must register the worker first',
    );
  }
  const capacity = Math.max(1, Math.floor(maxParallelRuns));
  const holderId = randomUUID();
  const acquired = await active.repository.acquireRunSlot({
    slotKey: workspaceKey,
    holderId,
    capacity,
    ttlMs: RUN_SLOT_TTL_MS,
    workerInstanceId: active.workerInstanceId,
  });
  if (!acquired) return null;
  const renewTimer = setInterval(() => {
    void active.repository
      .renewRunSlot({
        slotKey: workspaceKey,
        holderId,
        ttlMs: RUN_SLOT_TTL_MS,
      })
      .then((renewed) => {
        if (!renewed) {
          active.warn?.(
            { workspaceKey, holderId },
            'Run slot renewal failed because the slot is no longer held',
          );
        }
      })
      .catch((err) =>
        active.warn?.({ err, workspaceKey }, 'Failed to renew run slot'),
      );
  }, RUN_SLOT_RENEW_INTERVAL_MS);
  (
    renewTimer as ReturnType<typeof setInterval> & { unref?: () => void }
  ).unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(renewTimer);
    void active.repository
      .releaseRunSlot({ slotKey: workspaceKey, holderId })
      .catch((err) =>
        active.warn?.({ err, workspaceKey }, 'Failed to release run slot'),
      );
  };
}

export function resetSchedulerRunSlots(): void {
  backend = null;
}
