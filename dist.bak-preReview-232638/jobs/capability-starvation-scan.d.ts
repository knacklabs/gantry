import type { Job } from '../domain/types.js';
import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { WorkerRegistryRepository } from '../domain/ports/worker-coordination.js';
import { type CapabilityStarvationAlerter } from './capability-starvation.js';
/**
 * Bounded periodic capability-starvation scan (fleet mode only).
 *
 * A fleet-wide-unsatisfiable delivery requeues forever and never reaches the
 * per-run readiness pause (`requeuedIneligibleDelivery` skips `runJob` on every
 * ineligible worker, and runJob is the only path to `pauseJobForSetupIfNeeded`),
 * so a due job can starve silently. This scan is the safety net: for each
 * active due job older than {@link STARVATION_AGE_MS} whose required capability
 * set no active worker can satisfy, it raises ONE deduped starvation alert AND
 * pauses the job through the caller-supplied {@link
 * CapabilityStarvationScanDeps.pauseStarvedJob} hook — wired to the existing
 * readiness pause path (`pauseJobForSetupIfNeeded`), which re-checks fleet
 * satisfiability before pausing and surfaces the one-clear-user-action setup
 * state. The caller drives the scan from the existing scheduler-maintenance
 * sync (already stoppable), so this adds no timer of its own.
 */
export interface CapabilityStarvationScanDeps {
    skills?: SkillCatalogRepository;
    runtimeDependencies: RuntimeDependencyRepository;
    workerRegistry: WorkerRegistryRepository;
    alerter: CapabilityStarvationAlerter;
    /**
     * Pause a starved job via the existing readiness pause path
     * (`pauseJobForSetupIfNeeded`). Invoked for every starved job, even when the
     * alert deduped — the pause re-validates readiness itself and a paused job
     * leaves the active scan set, so this self-limits. Returns true when paused.
     */
    pauseStarvedJob?: (job: Job) => Promise<boolean>;
    now?: () => number;
    ageThresholdMs?: number;
    staleAfterMs?: number;
}
export interface CapabilityStarvationScanResult {
    scanned: number;
    starved: number;
    alerted: number;
    paused: number;
}
/**
 * Scan `jobs` (the active job set from the maintenance sync) for due jobs whose
 * required capabilities no active worker satisfies, and alert the aged ones.
 */
export declare function scanCapabilityStarvation(deps: CapabilityStarvationScanDeps, jobs: readonly Job[]): Promise<CapabilityStarvationScanResult>;
