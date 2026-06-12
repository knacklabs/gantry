import type { ProcessRole } from './process-role.js';
import { roleCapabilities } from './role-capabilities.js';

/**
 * Per-role readiness requirement flags. WP3 turns these into actual `/readyz`
 * checks; WP1 only declares them so later packages build on a single contract.
 * Each flag means "this role must satisfy this requirement before reporting
 * ready":
 *
 *  - `requiresWorkerRegistration`: a `worker_instances` row must exist.
 *  - `requiresSchedulerClaiming`: the scheduler loop must be claiming jobs.
 *  - `requiresLiveCapacitySignal`: this process must advertise live capacity.
 *  - `requiresApiAuthConfigured`: control API auth keys must be configured.
 */
export interface RoleReadinessRequirements {
  requiresWorkerRegistration: boolean;
  requiresSchedulerClaiming: boolean;
  requiresLiveCapacitySignal: boolean;
  requiresApiAuthConfigured: boolean;
}

/**
 * Derive the readiness requirement descriptor for a role from its capabilities.
 * Kept as a derivation (not a second hand-maintained table) so the two stay in
 * lockstep: a role is ready-gated on exactly the subsystems it actually runs.
 */
export function roleReadinessRequirements(
  role: ProcessRole,
): RoleReadinessRequirements {
  const caps = roleCapabilities(role);
  return {
    requiresWorkerRegistration: caps.workerRegistration,
    requiresSchedulerClaiming: caps.jobExecution,
    requiresLiveCapacitySignal: caps.liveExecution,
    // Any role that serves a control API surface (full or ops) needs auth.
    requiresApiAuthConfigured: true,
  };
}
