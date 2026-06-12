import type { JobSetupBlocker, JobSetupState } from '../domain/types.js';
import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { WorkerRegistryRepository } from '../domain/ports/worker-coordination.js';
import type { RuntimeDeploymentMode } from '../shared/runtime-deployment-mode.js';
import { stableSha256Json } from '../shared/stable-hash.js';
import { nowIso } from '../shared/time/datetime.js';
import { humanizeTechnicalIdentifier } from '../shared/user-visible-messages.js';
import { WORKER_STALE_AFTER_MS } from '../shared/worker-heartbeat.js';
import { resolveRequiredCapabilities } from './capability-eligibility.js';
import { fleetMissingRequiredCapabilities } from './capability-starvation.js';

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
export async function evaluateFleetCapabilityReadiness(
  deps: FleetCapabilityReadinessDeps,
  input: { appId: string; agentId: string },
): Promise<FleetCapabilityReadinessResult> {
  if (deps.deploymentMode !== 'fleet' || !deps.workerRegistry) {
    return {
      satisfiable: true,
      requiredCapabilities: [],
      missingCapabilities: [],
    };
  }
  const required = await resolveRequiredCapabilities(
    {
      deploymentMode: deps.deploymentMode,
      skills: deps.skills,
      runtimeDependencies: deps.runtimeDependencies,
    },
    input,
  );
  if (required.length === 0) {
    return {
      satisfiable: true,
      requiredCapabilities: [],
      missingCapabilities: [],
    };
  }
  const now = (deps.now ?? nowIso)();
  const staleBefore = new Date(
    Date.parse(now) - (deps.staleAfterMs ?? WORKER_STALE_AFTER_MS),
  ).toISOString();
  const activeCapabilities =
    await deps.workerRegistry.listActiveWorkerCapabilities({ staleBefore });
  const missing = fleetMissingRequiredCapabilities(
    required,
    activeCapabilities,
  );
  return {
    satisfiable: missing.length === 0,
    requiredCapabilities: required,
    missingCapabilities: missing,
  };
}

/** A user-actionable setup state for a fleet-wide unsatisfiable job. */
export function fleetCapabilitySetupState(input: {
  missingCapabilities: string[];
  checkedAt?: string;
  previous?: JobSetupState;
}): JobSetupState {
  const blockers = input.missingCapabilities.map(missingFleetCapabilityBlocker);
  const state = blockers[0]?.state ?? 'missing_capability';
  const fingerprint = stableSha256Json({
    state,
    blockers: blockers.map((blocker) => ({
      state: blocker.state,
      requirementType: blocker.requirementType,
      requirementId: blocker.requirementId,
      nextAction: blocker.nextAction,
    })),
  });
  return {
    state,
    checked_at: input.checkedAt ?? nowIso(),
    fingerprint,
    blockers,
    notified_fingerprint:
      input.previous?.fingerprint === fingerprint
        ? input.previous.notified_fingerprint
        : null,
  };
}

function missingFleetCapabilityBlocker(capabilityId: string): JobSetupBlocker {
  return {
    state: 'missing_capability',
    requirementType: 'semantic_capability',
    requirementId: capabilityId,
    message: `Setup required: ${describeFleetCapability(capabilityId)} is needed by this job but no active worker provides it.`,
    nextAction: fleetCapabilityNextAction(capabilityId),
  };
}

function describeFleetCapability(capabilityId: string): string {
  if (capabilityId.startsWith('skill:')) {
    return `the skill "${capabilityId.slice('skill:'.length)}"`;
  }
  if (capabilityId.startsWith('toolchain:')) {
    return 'an approved dependency toolchain';
  }
  return humanizeTechnicalIdentifier(capabilityId);
}

function fleetCapabilityNextAction(capabilityId: string): string {
  if (capabilityId.startsWith('toolchain:')) {
    return 'Approve and bake the required dependency so a worker can activate it, then resume the job.';
  }
  if (capabilityId.startsWith('skill:')) {
    return 'Approve and publish the required skill so a worker can activate it, then resume the job.';
  }
  return 'Provision the missing capability on a worker, then resume the job.';
}
