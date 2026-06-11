import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import {
  isWorkerEligibleForRequiredCapabilities,
  missingRequiredCapabilities,
} from './capability-eligibility.js';

/**
 * Capability-starvation alerting (fleet mode only).
 *
 * Two starvation causes are surfaced as ONE audit/runtime event plus an admin
 * notification, both deduped so a persistently starved item does not spam:
 *
 * - `pending_run`: a pending unit of work older than {@link STARVATION_AGE_MS}
 *   whose required capability set no active worker can satisfy. Caught by the
 *   periodic scheduler-maintenance scan because a fleet-wide-unsatisfiable
 *   delivery requeues forever (it never reaches the per-run readiness pause).
 * - `no_eligible_recoverer`: recoverable work exists (an expired lease / a
 *   recoverable live turn) but no active worker advertises its required set, so
 *   recovery would livelock. Caught at the recovery sweep.
 *
 * The event is the durable audit signal (existing runtime-events convention,
 * `task.notification`); dedupe is an in-memory per-(cause,key) cooldown on the
 * alerter instance so the same starved item alerts at most once per cooldown
 * window. The alerter holds no timers — it is driven by callers — so it is
 * inherently stoppable.
 */

export const STARVATION_AGE_MS = 5 * 60_000;
export const STARVATION_ALERT_COOLDOWN_MS = 30 * 60_000;

export type CapabilityStarvationCause = 'pending_run' | 'no_eligible_recoverer';

export interface CapabilityStarvationSignal {
  cause: CapabilityStarvationCause;
  appId: string;
  /** Stable dedupe key for this starved item (jobId, runId, or turnId). */
  key: string;
  jobId?: string | null;
  runId?: string | null;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  ageSeconds: number;
}

export interface CapabilityStarvationAlerterDeps {
  publishRuntimeEvent: (input: RuntimeEventPublishInput) => Promise<unknown>;
  cooldownMs?: number;
  now?: () => number;
  warn?: (context: Record<string, unknown>, message: string) => void;
}

/**
 * Emits the starvation audit event with per-(cause,key) cooldown dedupe. The
 * caller drives it from a bounded periodic scan; this object owns no timers.
 */
export class CapabilityStarvationAlerter {
  private readonly lastAlertedAt = new Map<string, number>();

  constructor(private readonly deps: CapabilityStarvationAlerterDeps) {}

  /** Alert for `signal` unless an identical alert is still within cooldown. */
  async alert(signal: CapabilityStarvationSignal): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)();
    const cooldownMs = this.deps.cooldownMs ?? STARVATION_ALERT_COOLDOWN_MS;
    const dedupeKey = `${signal.cause}\u0000${signal.appId}\u0000${signal.key}`;
    const last = this.lastAlertedAt.get(dedupeKey);
    if (last !== undefined && now - last < cooldownMs) return false;
    this.lastAlertedAt.set(dedupeKey, now);
    try {
      await this.deps.publishRuntimeEvent({
        appId: signal.appId as never,
        eventType: RUNTIME_EVENT_TYPES.TASK_NOTIFICATION,
        actor: 'scheduler',
        jobId: (signal.jobId ?? undefined) as never,
        runId: (signal.runId ?? undefined) as never,
        payload: {
          kind: 'capability_starvation',
          cause: signal.cause,
          key: signal.key,
          required_capabilities: signal.requiredCapabilities,
          missing_capabilities: signal.missingCapabilities,
          age_seconds: signal.ageSeconds,
          next_action: starvationRemediation(signal),
        },
      });
      return true;
    } catch (err) {
      // Re-allow alerting on the next pass if publishing failed.
      this.lastAlertedAt.delete(dedupeKey);
      this.deps.warn?.(
        { err, cause: signal.cause, key: signal.key },
        'Failed to publish capability-starvation alert',
      );
      return false;
    }
  }

  /** Clear cooldown state so a previously starved item can alert again. */
  clear(): void {
    this.lastAlertedAt.clear();
  }
}

function starvationRemediation(signal: CapabilityStarvationSignal): string {
  const missing =
    signal.missingCapabilities.length > 0
      ? signal.missingCapabilities.join(', ')
      : 'a fleet capability';
  return `No active worker advertises ${missing}. Approve and bake the missing dependency, or deploy a worker image that provides it.`;
}

/**
 * Whether ANY active worker advertises a superset of `required`. Pure helper
 * over the advertised sets returned by `listActiveWorkerCapabilities`; an empty
 * required set is always satisfiable.
 */
export function fleetCanSatisfyRequiredCapabilities(
  required: readonly string[],
  activeWorkerCapabilities: readonly (readonly string[])[],
): boolean {
  if (required.length === 0) return true;
  return activeWorkerCapabilities.some((advertised) =>
    isWorkerEligibleForRequiredCapabilities(required, advertised),
  );
}

/**
 * The required ids that NO active worker advertises — the fleet-wide gap. Empty
 * when the fleet can satisfy the set. Drives the user-facing "missing
 * dependency" message on readiness pause and on the starvation alert.
 */
export function fleetMissingRequiredCapabilities(
  required: readonly string[],
  activeWorkerCapabilities: readonly (readonly string[])[],
): string[] {
  if (required.length === 0) return [];
  const advertised = new Set<string>();
  for (const set of activeWorkerCapabilities) {
    for (const id of set) advertised.add(id);
  }
  return missingRequiredCapabilities(required, [...advertised]);
}
