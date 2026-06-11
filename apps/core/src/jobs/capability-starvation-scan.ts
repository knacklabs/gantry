import type { Job } from '../domain/types.js';
import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { WorkerRegistryRepository } from '../domain/ports/worker-coordination.js';
import { agentIdForJobWorkspaceKey } from '../application/jobs/job-tool-policy.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import { resolveRequiredCapabilities } from './capability-eligibility.js';
import {
  fleetMissingRequiredCapabilities,
  STARVATION_AGE_MS,
  type CapabilityStarvationAlerter,
} from './capability-starvation.js';
import { WORKER_STALE_AFTER_MS } from '../shared/worker-heartbeat.js';

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
export async function scanCapabilityStarvation(
  deps: CapabilityStarvationScanDeps,
  jobs: readonly Job[],
): Promise<CapabilityStarvationScanResult> {
  const nowMs = (deps.now ?? Date.now)();
  const ageThresholdMs = deps.ageThresholdMs ?? STARVATION_AGE_MS;
  const staleBefore = new Date(
    nowMs - (deps.staleAfterMs ?? WORKER_STALE_AFTER_MS),
  ).toISOString();
  const result: CapabilityStarvationScanResult = {
    scanned: 0,
    starved: 0,
    alerted: 0,
    paused: 0,
  };

  const dueJobs = jobs.filter((job) =>
    isDueOlderThan(job, nowMs, ageThresholdMs),
  );
  if (dueJobs.length === 0) return result;

  const activeCapabilities =
    await deps.workerRegistry.listActiveWorkerCapabilities({ staleBefore });

  for (const job of dueJobs) {
    result.scanned += 1;
    const agentId = agentIdForJobWorkspaceKey(job.workspace_key);
    const required = await resolveRequiredCapabilities(
      {
        deploymentMode: 'fleet',
        skills: deps.skills,
        runtimeDependencies: deps.runtimeDependencies,
      },
      { appId: DEFAULT_JOB_RUNTIME_APP_ID, agentId },
    );
    if (required.length === 0) continue;
    const missing = fleetMissingRequiredCapabilities(
      required,
      activeCapabilities,
    );
    if (missing.length === 0) continue;
    result.starved += 1;
    const alerted = await deps.alerter.alert({
      cause: 'pending_run',
      appId: DEFAULT_JOB_RUNTIME_APP_ID,
      key: job.id,
      jobId: job.id,
      requiredCapabilities: required,
      missingCapabilities: missing,
      ageSeconds: jobDueAgeSeconds(job, nowMs),
    });
    if (alerted) result.alerted += 1;
    if (deps.pauseStarvedJob) {
      try {
        if (await deps.pauseStarvedJob(job)) result.paused += 1;
      } catch {
        // A pause failure must not abort the scan; the next maintenance pass
        // retries while the requeue loop keeps the job pending (not lost).
      }
    }
  }
  return result;
}

function isDueOlderThan(
  job: Job,
  nowMs: number,
  ageThresholdMs: number,
): boolean {
  if (job.status !== 'active' || !job.next_run) return false;
  const dueMs = Date.parse(job.next_run);
  if (Number.isNaN(dueMs)) return false;
  return nowMs - dueMs >= ageThresholdMs;
}

function jobDueAgeSeconds(job: Job, nowMs: number): number {
  const dueMs = job.next_run ? Date.parse(job.next_run) : nowMs;
  if (Number.isNaN(dueMs)) return 0;
  return Math.max(0, Math.floor((nowMs - dueMs) / 1000));
}
