import type { RuntimeDependency, RuntimeDependencyRepository, RuntimeDependencyStatus, StaleRuntimeDependencyLister } from '../domain/ports/fleet-capability-state.js';
import type { ToolchainBakeQueuePort } from './toolchain-bake-enqueue.js';
import { type ToolchainBakeNotifier } from './toolchain-bake-executor.js';
export declare const DEFAULT_BAKE_REAP_INTERVAL_MS = 60000;
/** Reap threshold: ≥ 2× install timeout + upload allowance (15 min default). */
export declare function bakeReapStalenessMs(installTimeoutMs?: number): number;
export interface ToolchainBakeResetDeps {
    runtimeDependencies: RuntimeDependencyRepository;
    queue: ToolchainBakeQueuePort;
    notifier: ToolchainBakeNotifier;
}
export type ToolchainBakeResetOutcome = 
/** Row reset to queued (or freshness re-stamped) and the bake re-enqueued. */
'requeued'
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
export declare function resetToolchainBakeForRequeue(deps: ToolchainBakeResetDeps, input: {
    dependency: RuntimeDependency;
    fromStatuses: RuntimeDependencyStatus[];
    stalenessMs: number;
    now?: number;
}): Promise<ToolchainBakeResetOutcome>;
export interface ToolchainBakeReaperDeps extends ToolchainBakeResetDeps {
    runtimeDependencies: RuntimeDependencyRepository & StaleRuntimeDependencyLister;
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
export declare class ToolchainBakeReaper {
    private readonly deps;
    private timer;
    private inFlight;
    constructor(deps: ToolchainBakeReaperDeps);
    start(): void;
    stop(): Promise<void>;
    /** One reap pass. Coalesces with an already-running pass. */
    runOnce(): Promise<ToolchainBakeReapResult>;
    private tick;
    private reap;
}
