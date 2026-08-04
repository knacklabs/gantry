import type { Job } from '../domain/types.js';
import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { RuntimeDeploymentMode } from '../shared/runtime-deployment-mode.js';
/**
 * Capability-matched dispatch gate for scheduler job deliveries (fleet only).
 *
 * Before a worker claims a due job, it resolves the job's required capability
 * set from the executing agent's current selections and compares it against its
 * OWN advertised set (`worker_instances.capabilities_json`, kept current by the
 * reconciler). An ineligible worker must not claim; its delivery requeues with a
 * delay + jitter WITHOUT consuming the job's retry budget (see scheduler-engine).
 *
 * Workstation mode always resolves to the empty set, so this gate is a no-op
 * there — existing single-host dispatch is unchanged.
 */
/** Base delay before an ineligible delivery is retried by another worker. */
export declare const INELIGIBLE_REQUEUE_BASE_DELAY_MS = 15000;
/** Upper bound of the random jitter added to the base requeue delay. */
export declare const INELIGIBLE_REQUEUE_JITTER_MS = 15000;
export type CapabilityDispatchDecision = {
    outcome: 'eligible';
    requiredCapabilities: string[];
} | {
    outcome: 'ineligible';
    requiredCapabilities: string[];
    missingCapabilities: string[];
} | {
    outcome: 'skip_check';
    requiredCapabilities: readonly string[];
};
export interface CapabilityDispatchDeps {
    deploymentMode: RuntimeDeploymentMode;
    skills?: SkillCatalogRepository;
    runtimeDependencies?: RuntimeDependencyRepository;
    /** Advertised capability set of the worker considering this delivery. */
    workerAdvertisedCapabilities: () => Promise<string[] | null>;
    warn?: (context: Record<string, unknown>, message: string) => void;
}
/**
 * Resolve the job's required set and decide whether THIS worker may claim it.
 *
 * - workstation mode ⇒ always `eligible` with an empty set (no-op gate).
 * - empty required set ⇒ `eligible` (runnable anywhere).
 * - worker advertised set unavailable ⇒ `skip_check`: proceed to claim. Failing
 *   open here avoids a self-inflicted livelock from a transient read; the run is
 *   still lease-protected and re-evaluated by readiness. This is the deliberate
 *   choice for the "can't determine my own capabilities" edge.
 * - advertised set covers required ⇒ `eligible`.
 * - otherwise ⇒ `ineligible` with the missing ids.
 */
export declare function decideCapabilityDispatch(deps: CapabilityDispatchDeps, job: Pick<Job, 'workspace_key'>): Promise<CapabilityDispatchDecision>;
/** Whether the persisted required set differs from a freshly resolved one. */
export declare function requiredCapabilitiesChanged(stored: readonly string[] | null | undefined, resolved: readonly string[]): boolean;
/** Delay (ms) before an ineligible delivery is retried, with jitter applied. */
export declare function ineligibleRequeueDelayMs(random?: () => number): number;
