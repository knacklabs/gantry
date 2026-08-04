import type { JobSetupState } from '../domain/types.js';
import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { WorkerRegistryRepository } from '../domain/ports/worker-coordination.js';
import type { RuntimeDeploymentMode } from '../shared/runtime-deployment-mode.js';
/**
 * Fleet-wide capability readiness for scheduled jobs (fleet mode only).
 *
 * A job is paused ONLY when no ACTIVE worker advertises the capability set it
 * needs — fleet-wide unsatisfiability — never on local-worker insufficiency
 * (that case requeues to an eligible worker). The pause surfaces one clear user
 * action per AGENTS.md: approve/bake the named missing dependency. Workstation
 * mode resolves an empty set, so this never pauses a single-host job.
 */
export interface FleetCapabilityReadinessDeps {
    deploymentMode: RuntimeDeploymentMode;
    skills?: SkillCatalogRepository;
    runtimeDependencies?: RuntimeDependencyRepository;
    workerRegistry?: WorkerRegistryRepository;
    now?: () => string;
    staleAfterMs?: number;
}
export interface FleetCapabilityReadinessResult {
    satisfiable: boolean;
    requiredCapabilities: string[];
    missingCapabilities: string[];
}
/**
 * Resolve the job's required set and check whether the active fleet can satisfy
 * it. `satisfiable` is true when the set is empty or at least one active worker
 * advertises a superset; otherwise `missingCapabilities` names the gap.
 */
export declare function evaluateFleetCapabilityReadiness(deps: FleetCapabilityReadinessDeps, input: {
    appId: string;
    agentId: string;
}): Promise<FleetCapabilityReadinessResult>;
/** A user-actionable setup state for a fleet-wide unsatisfiable job. */
export declare function fleetCapabilitySetupState(input: {
    missingCapabilities: string[];
    checkedAt?: string;
    previous?: JobSetupState;
}): JobSetupState;
