import { randomUUID } from 'node:crypto';

import type { RunSlotRepository } from '../domain/ports/worker-coordination.js';
import {
  hostExecutionSlotHolderId,
  hostExecutionSlotKey,
} from '../shared/host-capacity.js';
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

type RunSlotRelease = () => void | Promise<void>;

interface PermissionWaitRunSlot {
  activeRelease: RunSlotRelease | null;
  closed: boolean;
  acquiring: Promise<void> | null;
  acquire(): Promise<void>;
}

let backend: RunSlotBackend | null = null;
const permissionWaitRunSlots = new Map<string, PermissionWaitRunSlot>();

export function configureRunSlotBackend(next: RunSlotBackend | null): void {
  backend = next;
}

export async function acquireRunSlot(
  workspaceKey: string,
  maxParallelRuns = DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP,
  options: {
    hostCapacity?: number;
    hostBudgetCapacity?: number;
    runId?: string | null;
    onSlotLost?: () => void;
  } = {},
): Promise<RunSlotRelease> {
  for (;;) {
    const release = await tryAcquireRunSlot(
      workspaceKey,
      maxParallelRuns,
      options,
    );
    if (release) return release;
    await sleep(RUN_SLOT_RETRY_DELAY_MS);
  }
}

export async function tryAcquireRunSlot(
  workspaceKey: string,
  maxParallelRuns = DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP,
  options: {
    hostCapacity?: number;
    hostBudgetCapacity?: number;
    runId?: string | null;
    onSlotLost?: () => void;
  } = {},
): Promise<RunSlotRelease | null> {
  const release = await tryAcquireRunSlotLease(
    workspaceKey,
    maxParallelRuns,
    options,
  );
  const runId = options.runId?.trim();
  if (!release || !runId) return release;
  const control: PermissionWaitRunSlot = {
    activeRelease: release,
    closed: false,
    acquiring: null,
    async acquire() {
      if (control.closed) {
        throw new Error(`Run slot is closed for ${runId}.`);
      }
      if (control.activeRelease) return;
      control.acquiring ??= (async () => {
        for (;;) {
          if (control.closed) {
            throw new Error(`Run slot is closed for ${runId}.`);
          }
          const next = await tryAcquireRunSlotLease(
            workspaceKey,
            maxParallelRuns,
            options,
          );
          if (next) {
            control.activeRelease = next;
            return;
          }
          await sleep(RUN_SLOT_RETRY_DELAY_MS);
        }
      })().finally(() => {
        control.acquiring = null;
      });
      await control.acquiring;
    },
  };
  permissionWaitRunSlots.set(runId, control);
  return async () => {
    if (control.closed) return;
    control.closed = true;
    if (permissionWaitRunSlots.get(runId) === control) {
      permissionWaitRunSlots.delete(runId);
    }
    const activeRelease = control.activeRelease;
    control.activeRelease = null;
    await activeRelease?.();
  };
}

async function tryAcquireRunSlotLease(
  workspaceKey: string,
  maxParallelRuns = DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP,
  options: {
    hostCapacity?: number;
    hostBudgetCapacity?: number;
    runId?: string | null;
    onSlotLost?: () => void;
  } = {},
): Promise<RunSlotRelease | null> {
  const active = backend;
  if (!active) {
    throw new Error(
      'Run slot backend is not configured; scheduler startup must register the worker first',
    );
  }
  const capacity = Math.floor(maxParallelRuns);
  if (capacity <= 0) return null;
  const hostCapacity =
    typeof options.hostCapacity === 'number'
      ? Math.floor(options.hostCapacity)
      : undefined;
  if (hostCapacity !== undefined && hostCapacity <= 0) return null;
  const hostBudgetCapacity =
    typeof options.hostBudgetCapacity === 'number'
      ? Math.floor(options.hostBudgetCapacity)
      : hostCapacity;
  if (hostCapacity !== undefined && Number(hostBudgetCapacity) <= 0) {
    return null;
  }
  const holderId = randomUUID();
  const hostBudgetSlotKey = hostExecutionSlotKey(active.workerInstanceId);
  const hostClassSlotKey = hostExecutionSlotKey(
    active.workerInstanceId,
    'background',
  );
  const hostHolderId = hostExecutionSlotHolderId(holderId);
  if (hostCapacity !== undefined) {
    const hostBudgetAcquired = await active.repository.acquireRunSlot({
      slotKey: hostBudgetSlotKey,
      holderId: hostHolderId,
      capacity: hostBudgetCapacity!,
      ttlMs: RUN_SLOT_TTL_MS,
      runId: options.runId ?? null,
      workerInstanceId: active.workerInstanceId,
    });
    if (!hostBudgetAcquired) return null;
    let hostClassAcquired: boolean;
    try {
      hostClassAcquired = await active.repository.acquireRunSlot({
        slotKey: hostClassSlotKey,
        holderId: hostHolderId,
        capacity: hostCapacity,
        ttlMs: RUN_SLOT_TTL_MS,
        runId: options.runId ?? null,
        workerInstanceId: active.workerInstanceId,
      });
    } catch (err) {
      await active.repository.releaseRunSlot({
        slotKey: hostBudgetSlotKey,
        holderId: hostHolderId,
      });
      throw err;
    }
    if (!hostClassAcquired) {
      await active.repository.releaseRunSlot({
        slotKey: hostBudgetSlotKey,
        holderId: hostHolderId,
      });
      return null;
    }
  }
  let acquired: boolean;
  try {
    acquired = await active.repository.acquireRunSlot({
      slotKey: workspaceKey,
      holderId,
      capacity,
      ttlMs: RUN_SLOT_TTL_MS,
      runId: options.runId ?? null,
      workerInstanceId: active.workerInstanceId,
    });
  } catch (err) {
    if (hostCapacity !== undefined) {
      await active.repository.releaseRunSlot({
        slotKey: hostClassSlotKey,
        holderId: hostHolderId,
      });
      await active.repository.releaseRunSlot({
        slotKey: hostBudgetSlotKey,
        holderId: hostHolderId,
      });
    }
    throw err;
  }
  if (!acquired) {
    if (hostCapacity !== undefined) {
      await active.repository.releaseRunSlot({
        slotKey: hostClassSlotKey,
        holderId: hostHolderId,
      });
      await active.repository.releaseRunSlot({
        slotKey: hostBudgetSlotKey,
        holderId: hostHolderId,
      });
    }
    return null;
  }
  let hostSlotLost = false;
  const reportHostSlotLost = (message: string): void => {
    if (hostSlotLost) return;
    hostSlotLost = true;
    clearInterval(renewTimer);
    active.warn?.({ workspaceKey, holderId }, message);
    options.onSlotLost?.();
  };
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
    if (hostCapacity !== undefined) {
      void active.repository
        .renewRunSlot({
          slotKey: hostBudgetSlotKey,
          holderId: hostHolderId,
          ttlMs: RUN_SLOT_TTL_MS,
        })
        .then((renewed) => {
          if (!renewed) {
            reportHostSlotLost(
              'Failed to renew host execution budget slot because it is no longer held',
            );
          }
        })
        .catch((err) =>
          active.warn?.(
            { err, workspaceKey },
            'Failed to renew host execution budget slot',
          ),
        );
      void active.repository
        .renewRunSlot({
          slotKey: hostClassSlotKey,
          holderId: hostHolderId,
          ttlMs: RUN_SLOT_TTL_MS,
        })
        .then((renewed) => {
          if (!renewed) {
            reportHostSlotLost(
              'Failed to renew host execution slot because it is no longer held',
            );
          }
        })
        .catch((err) =>
          active.warn?.(
            { err, workspaceKey },
            'Failed to renew host execution slot',
          ),
        );
    }
  }, RUN_SLOT_RENEW_INTERVAL_MS);
  (
    renewTimer as ReturnType<typeof setInterval> & { unref?: () => void }
  ).unref?.();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(renewTimer);
    const releases = [
      active.repository
        .releaseRunSlot({ slotKey: workspaceKey, holderId })
        .catch((err) =>
          active.warn?.({ err, workspaceKey }, 'Failed to release run slot'),
        ),
    ];
    if (hostCapacity !== undefined) {
      releases.push(
        active.repository
          .releaseRunSlot({ slotKey: hostClassSlotKey, holderId: hostHolderId })
          .catch((err) =>
            active.warn?.(
              { err, workspaceKey },
              'Failed to release host execution slot',
            ),
          ),
        active.repository
          .releaseRunSlot({
            slotKey: hostBudgetSlotKey,
            holderId: hostHolderId,
          })
          .catch((err) =>
            active.warn?.(
              { err, workspaceKey },
              'Failed to release host execution budget slot',
            ),
          ),
      );
    }
    await Promise.all(releases);
  };
}

export async function releaseRunSlotForPermissionWait(input: {
  runId: string;
}): Promise<boolean> {
  const control = permissionWaitRunSlots.get(input.runId);
  if (!control || control.closed) return false;
  if (!control.activeRelease) return true;
  const release = control.activeRelease;
  control.activeRelease = null;
  await release();
  return true;
}

export async function acquireRunSlotForPermissionWake(input: {
  runId: string;
}): Promise<boolean> {
  const control = permissionWaitRunSlots.get(input.runId);
  if (!control || control.closed) {
    return false;
  }
  await control.acquire();
  return true;
}

export function resetSchedulerRunSlots(): void {
  for (const control of permissionWaitRunSlots.values()) {
    control.closed = true;
    void control.activeRelease?.();
  }
  permissionWaitRunSlots.clear();
  backend = null;
}
