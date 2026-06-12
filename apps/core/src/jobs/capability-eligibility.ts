import type { RuntimeDeploymentMode } from '../shared/runtime-deployment-mode.js';
import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import {
  skillCapabilityId,
  toolchainCapabilityId,
} from './worker-capability-reconciler.js';

/**
 * Capability-matched dispatch (fleet mode only).
 *
 * A run's "required capability set" is the set of fleet-distributed capability
 * ids it needs an executing worker to advertise: `skill:<id>` for each skill the
 * executing agent has selected, and `toolchain:<manifestHash>` for each approved
 * dependency manifest the agent needs. A worker advertises the union of its image
 * inventory and the artifacts it has activated (kept current in
 * `worker_instances.capabilities_json` by {@link WorkerCapabilityReconciler}).
 *
 * Eligibility is a plain superset check: a worker may claim a run only when its
 * advertised set covers the run's required set. This is the plan's explicit
 * decision — compare locally in the claim path, no GIN index and no SQL
 * set-containment. Empty required set ⇒ eligible everywhere.
 *
 * In `workstation` mode the required set is ALWAYS empty: a single host installs
 * skills/dependencies live and is always locally eligible. Only `fleet` mode,
 * where capabilities are distributed across immutable workers, produces a
 * non-empty set. This keeps workstation behavior unchanged (zero regression).
 */

/** A run requires no fleet-distributed capabilities ⇒ runnable on any worker. */
export const EMPTY_REQUIRED_CAPABILITIES: readonly string[] = [];

export interface RequiredCapabilityResolverDeps {
  deploymentMode: RuntimeDeploymentMode;
  skills?: SkillCatalogRepository;
  runtimeDependencies?: RuntimeDependencyRepository;
}

/**
 * Resolve the required capability set for a run executed by `agentId` under
 * `appId`. Returns a sorted, de-duped `string[]`. Returns the empty set in
 * workstation mode, or when the repositories needed to resolve it are absent.
 *
 * Toolchain linkage mirrors the bake-enqueue provenance (c4f22aac): a
 * runtime_dependencies row is attributed to the agent that requested the
 * dependency via `requestedByAgentId`; an `uploaded`/`activated` manifest for
 * this agent is required so the run only lands on a worker that has activated
 * that toolchain artifact.
 */
export async function resolveRequiredCapabilities(
  deps: RequiredCapabilityResolverDeps,
  input: { appId: string; agentId: string },
): Promise<string[]> {
  if (deps.deploymentMode !== 'fleet') return [];

  const required = new Set<string>();

  if (deps.skills) {
    const bindings = await deps.skills.listAgentSkillBindings({
      appId: input.appId as never,
      agentId: input.agentId as never,
    });
    for (const binding of bindings) {
      if (binding.status !== 'active') continue;
      required.add(skillCapabilityId(String(binding.skillId)));
    }
  }

  if (deps.runtimeDependencies) {
    const rows = await deps.runtimeDependencies.listRuntimeDependencies({
      appId: input.appId,
      statuses: ['uploaded', 'activated'],
    });
    for (const row of rows) {
      if (row.requestedByAgentId !== input.agentId) continue;
      required.add(toolchainCapabilityId(row.manifestHash));
    }
  }

  return normalizeCapabilitySet([...required]);
}

/** Sort + de-dupe a capability id list into the canonical flat-set shape. */
export function normalizeCapabilitySet(
  capabilities: readonly string[] | null | undefined,
): string[] {
  if (!capabilities || capabilities.length === 0) return [];
  return [
    ...new Set(capabilities.map((id) => id.trim()).filter(Boolean)),
  ].sort();
}

/**
 * Whether a worker advertising `advertised` may claim a run requiring
 * `required`. Empty required ⇒ always eligible. Otherwise every required id
 * must be present in the advertised set (plain superset check).
 */
export function isWorkerEligibleForRequiredCapabilities(
  required: readonly string[] | null | undefined,
  advertised: readonly string[] | null | undefined,
): boolean {
  if (!required || required.length === 0) return true;
  const advertisedSet = new Set(advertised ?? []);
  for (const capabilityId of required) {
    if (!advertisedSet.has(capabilityId)) return false;
  }
  return true;
}

/**
 * The required ids a worker advertising `advertised` is missing for `required`.
 * Empty when the worker is eligible. Used by starvation/readiness diagnostics.
 */
export function missingRequiredCapabilities(
  required: readonly string[] | null | undefined,
  advertised: readonly string[] | null | undefined,
): string[] {
  if (!required || required.length === 0) return [];
  const advertisedSet = new Set(advertised ?? []);
  return required.filter((capabilityId) => !advertisedSet.has(capabilityId));
}
