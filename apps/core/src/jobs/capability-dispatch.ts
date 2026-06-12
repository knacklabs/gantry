import type { Job } from '../domain/types.js';
import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { RuntimeDeploymentMode } from '../shared/runtime-deployment-mode.js';
import { agentIdForJobWorkspaceKey } from '../application/jobs/job-tool-policy.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import {
  isWorkerEligibleForRequiredCapabilities,
  normalizeCapabilitySet,
  resolveRequiredCapabilities,
} from './capability-eligibility.js';

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
export const INELIGIBLE_REQUEUE_BASE_DELAY_MS = 15_000;
/** Upper bound of the random jitter added to the base requeue delay. */
export const INELIGIBLE_REQUEUE_JITTER_MS = 15_000;

export type CapabilityDispatchDecision =
  | { outcome: 'eligible'; requiredCapabilities: string[] }
  | {
      outcome: 'ineligible';
      requiredCapabilities: string[];
      missingCapabilities: string[];
    }
  | { outcome: 'skip_check'; requiredCapabilities: readonly string[] };

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
export async function decideCapabilityDispatch(
  deps: CapabilityDispatchDeps,
  job: Pick<Job, 'workspace_key'>,
): Promise<CapabilityDispatchDecision> {
  if (deps.deploymentMode !== 'fleet') {
    return { outcome: 'eligible', requiredCapabilities: [] };
  }
  const agentId = agentIdForJobWorkspaceKey(job.workspace_key);
  const required = await resolveRequiredCapabilities(
    {
      deploymentMode: deps.deploymentMode,
      skills: deps.skills,
      runtimeDependencies: deps.runtimeDependencies,
    },
    { appId: DEFAULT_JOB_RUNTIME_APP_ID, agentId },
  );
  if (required.length === 0) {
    return { outcome: 'eligible', requiredCapabilities: [] };
  }
  const advertised = await deps.workerAdvertisedCapabilities();
  if (advertised === null) {
    deps.warn?.(
      { workspaceKey: job.workspace_key, requiredCapabilities: required },
      'Worker advertised capability set unavailable; proceeding with claim (fail-open)',
    );
    return { outcome: 'skip_check', requiredCapabilities: required };
  }
  if (isWorkerEligibleForRequiredCapabilities(required, advertised)) {
    return { outcome: 'eligible', requiredCapabilities: required };
  }
  return {
    outcome: 'ineligible',
    requiredCapabilities: required,
    missingCapabilities: required.filter((id) => !new Set(advertised).has(id)),
  };
}

/** Whether the persisted required set differs from a freshly resolved one. */
export function requiredCapabilitiesChanged(
  stored: readonly string[] | null | undefined,
  resolved: readonly string[],
): boolean {
  const a = normalizeCapabilitySet(stored);
  const b = normalizeCapabilitySet(resolved);
  if (a.length !== b.length) return true;
  return a.some((value, index) => value !== b[index]);
}

/** Delay (ms) before an ineligible delivery is retried, with jitter applied. */
export function ineligibleRequeueDelayMs(
  random: () => number = Math.random,
): number {
  return (
    INELIGIBLE_REQUEUE_BASE_DELAY_MS +
    Math.floor(random() * INELIGIBLE_REQUEUE_JITTER_MS)
  );
}
