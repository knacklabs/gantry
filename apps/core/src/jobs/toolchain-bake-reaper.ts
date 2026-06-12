import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
  RuntimeDependencyStatus,
  StaleRuntimeDependencyLister,
} from '../domain/ports/fleet-capability-state.js';
import { toIso } from '../shared/time/datetime.js';
import type { ToolchainBakeQueuePort } from './toolchain-bake-enqueue.js';
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  type ToolchainBakeNotifier,
} from './toolchain-bake-executor.js';

/**
 * Recovery for bakes that stopped making progress.
 *
 * Two stranding modes exist by construction (retryLimit:0 queue + a dead-letter
 * nobody consumes):
 * - `baking` stuck: the claiming worker hard-died (SIGKILL/OOM) or was drained
 *   mid-install, so the catch that writes `failed` never ran.
 * - `queued` stuck: the pg-boss delivery was lost or dead-lettered before the
 *   claim CAS, so no worker will ever pick the row up again.
 *
 * The reaper CAS-resets stale rows back to `queued` (bumping `updated_at`,
 * which every status write does — no schema change), re-enqueues the bake, and
 * re-NOTIFYs the manifest channel. Staleness is measured against `updated_at`
 * with a generous threshold (≥ 2× the install timeout + an upload allowance) so
 * a slow-but-alive baker is effectively never clobbered; if one ever is, the
 * executor's fromStatus-guarded terminal CAS makes the loser's write a benign
 * no-op (see the executor lifecycle comment for the full double-bake analysis).
 *
 * `resetToolchainBakeForRequeue` is the single reset code path — the reaper,
 * `gantry bake rebake`, and `gantry artifacts quarantine rebake` all go through
 * it so the in-flight guard cannot be bypassed.
 */

/** Pack + upload allowance beyond the install before `baking` counts as stale. */
const BAKE_UPLOAD_ALLOWANCE_MS = 5 * 60_000;
export const DEFAULT_BAKE_REAP_INTERVAL_MS = 60_000;

/** Reap threshold: ≥ 2× install timeout + upload allowance (15 min default). */
export function bakeReapStalenessMs(
  installTimeoutMs: number = DEFAULT_INSTALL_TIMEOUT_MS,
): number {
  return 2 * installTimeoutMs + BAKE_UPLOAD_ALLOWANCE_MS;
}

export interface ToolchainBakeResetDeps {
  runtimeDependencies: RuntimeDependencyRepository;
  queue: ToolchainBakeQueuePort;
  notifier: ToolchainBakeNotifier;
}

export type ToolchainBakeResetOutcome =
  /** Row reset to queued (or freshness re-stamped) and the bake re-enqueued. */
  | 'requeued'
  /** Row is `baking` and younger than the threshold: a live worker owns it. */
  | 'in_flight'
  /** The guarded CAS found a different status: someone else moved the row. */
  | 'lost_race'
  /** Row status is not in the caller's allowed reset set. */
  | 'not_resettable';

/**
 * Guarded reset + re-enqueue + re-NOTIFY for one manifest row. `fromStatuses`
 * is the caller's allowed set (reaper: queued|baking; `bake rebake`:
 * failed|baking; quarantine rebake adds uploaded|activated). A `baking` row is
 * additionally gated by `stalenessMs`: younger rows are in flight and are never
 * clobbered. The reset itself is a fromStatus CAS, so two concurrent resetters
 * (or a resetter racing the live baker's terminal write) serialize — exactly
 * one wins; the loser reports `lost_race`.
 */
export async function resetToolchainBakeForRequeue(
  deps: ToolchainBakeResetDeps,
  input: {
    dependency: RuntimeDependency;
    fromStatuses: RuntimeDependencyStatus[];
    stalenessMs: number;
    now?: number;
  },
): Promise<ToolchainBakeResetOutcome> {
  const { dependency } = input;
  if (!input.fromStatuses.includes(dependency.status)) {
    return 'not_resettable';
  }
  if (dependency.status === 'baking') {
    const now = input.now ?? Date.now();
    const ageMs = now - Date.parse(dependency.updatedAt);
    if (Number.isFinite(ageMs) && ageMs < input.stalenessMs) {
      return 'in_flight';
    }
  }
  const reset = await deps.runtimeDependencies.updateRuntimeDependencyStatus({
    id: dependency.id,
    status: 'queued',
    fromStatus: dependency.status,
    failureReason: null,
  });
  if (!reset) return 'lost_race';
  await deps.queue.enqueueBake({
    dependencyId: dependency.id,
    manifestHash: dependency.manifestHash,
  });
  await deps.notifier.notifyManifestChanged({
    appId: dependency.appId,
    manifestHash: dependency.manifestHash,
    status: 'queued',
  });
  return 'requeued';
}

export interface ToolchainBakeReaperDeps extends ToolchainBakeResetDeps {
  runtimeDependencies: RuntimeDependencyRepository &
    StaleRuntimeDependencyLister;
  stalenessMs?: number;
  intervalMs?: number;
  now?: () => number;
  logInfo?: (context: Record<string, unknown>, message: string) => void;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface ToolchainBakeReapResult {
  scanned: number;
  requeued: number;
}

/**
 * Bounded periodic reaper. Started/stopped with the bake subsystem (fleet mode
 * only) so workstation never runs it. The first pass runs immediately on start
 * so a row stranded by the previous deploy recovers without waiting a full
 * interval. Stoppable per AGENTS: `stop()` clears the timer; an in-flight pass
 * is awaited by callers via {@link runOnce} in tests.
 */
export class ToolchainBakeReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<ToolchainBakeReapResult> | null = null;

  constructor(private readonly deps: ToolchainBakeReaperDeps) {}

  start(): void {
    if (this.timer) return;
    const setIntervalFn = this.deps.setIntervalFn ?? setInterval;
    const timer = setIntervalFn(
      () => void this.tick(),
      this.deps.intervalMs ?? DEFAULT_BAKE_REAP_INTERVAL_MS,
    );
    (
      timer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
    this.timer = timer;
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => {});
  }

  /** One reap pass. Coalesces with an already-running pass. */
  runOnce(): Promise<ToolchainBakeReapResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reap().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.deps.logWarn?.({ err }, 'Toolchain bake reap pass failed');
    }
  }

  private async reap(): Promise<ToolchainBakeReapResult> {
    const stalenessMs = this.deps.stalenessMs ?? bakeReapStalenessMs();
    const now = (this.deps.now ?? Date.now)();
    const stale =
      await this.deps.runtimeDependencies.listStaleRuntimeDependencies({
        statuses: ['queued', 'baking'],
        updatedBefore: toIso(now - stalenessMs),
      });
    const result: ToolchainBakeReapResult = {
      scanned: stale.length,
      requeued: 0,
    };
    for (const dependency of stale) {
      try {
        const outcome = await resetToolchainBakeForRequeue(this.deps, {
          dependency,
          fromStatuses: ['queued', 'baking'],
          stalenessMs,
          now,
        });
        if (outcome === 'requeued') {
          result.requeued += 1;
          this.deps.logInfo?.(
            {
              dependencyId: dependency.id,
              manifestHash: dependency.manifestHash,
              previousStatus: dependency.status,
              staleSince: dependency.updatedAt,
            },
            'Reaped stale toolchain bake; reset to queued and re-enqueued',
          );
        }
      } catch (err) {
        this.deps.logWarn?.(
          { err, dependencyId: dependency.id },
          'Failed to reap stale toolchain bake',
        );
      }
    }
    return result;
  }
}
