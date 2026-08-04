import type { RuntimeEventPublishInput } from '../domain/events/events.js';
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
export declare const STARVATION_AGE_MS: number;
export declare const STARVATION_ALERT_COOLDOWN_MS: number;
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
export declare class CapabilityStarvationAlerter {
    private readonly deps;
    private readonly lastAlertedAt;
    constructor(deps: CapabilityStarvationAlerterDeps);
    /** Alert for `signal` unless an identical alert is still within cooldown. */
    alert(signal: CapabilityStarvationSignal): Promise<boolean>;
    /** Clear cooldown state so a previously starved item can alert again. */
    clear(): void;
}
/**
 * Whether ANY active worker advertises a superset of `required`. Pure helper
 * over the advertised sets returned by `listActiveWorkerCapabilities`; an empty
 * required set is always satisfiable.
 */
export declare function fleetCanSatisfyRequiredCapabilities(required: readonly string[], activeWorkerCapabilities: readonly (readonly string[])[]): boolean;
/**
 * The required ids that NO active worker advertises — the fleet-wide gap. Empty
 * when the fleet can satisfy the set. Drives the user-facing "missing
 * dependency" message on readiness pause and on the starvation alert.
 */
export declare function fleetMissingRequiredCapabilities(required: readonly string[], activeWorkerCapabilities: readonly (readonly string[])[]): string[];
