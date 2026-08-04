import { roleCapabilities } from './role-capabilities.js';
/**
 * Derive the readiness requirement descriptor for a role from its capabilities.
 * Kept as a derivation (not a second hand-maintained table) so the two stay in
 * lockstep: a role is ready-gated on exactly the subsystems it actually runs.
 */
export function roleReadinessRequirements(role) {
    const caps = roleCapabilities(role);
    return {
        requiresWorkerRegistration: caps.workerRegistration,
        requiresSchedulerClaiming: caps.jobExecution,
        requiresLiveCapacitySignal: caps.liveExecution,
        // Any role that serves a control API surface (full or ops) needs auth.
        requiresApiAuthConfigured: true,
    };
}
