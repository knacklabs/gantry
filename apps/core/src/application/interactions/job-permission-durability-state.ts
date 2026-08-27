import type {
  JobPermissionCardRecord,
  JobPermissionCardRowSnapshot,
  JobPermissionDurabilityState,
  JobPermissionNeedRecord,
  JobPermissionPendingBudget,
} from '../../domain/ports/job-permission-durability.js';
import type { ParsedJobPermissionCardAction } from '../../domain/job-permission-card-actions.js';
import { sha256Hex } from '../../shared/stable-hash.js';

export const MAX_JOB_PERMISSION_WAIT_MS = 24 * 60 * 60_000;
const NEVER_EXPIRES_AT = '9999-12-31T23:59:59.999Z';

export function canonicalJobPermissionNeedIdentity(
  grantAtoms: readonly string[],
): string {
  const atoms = canonicalAtoms(grantAtoms);
  if (atoms.length === 0) throw new Error('Canonical need scope is empty.');
  return JSON.stringify(atoms);
}

export function jobPermissionNeedId(
  appId: string,
  jobId: string,
  canonicalIdentity: string,
): string {
  return `job-permission-need:${sha256Hex(
    JSON.stringify([appId, jobId, canonicalIdentity]),
  )}`;
}

export function jobPermissionCardId(appId: string, jobId: string): string {
  return `job-permission-card:${sha256Hex(JSON.stringify([appId, jobId]))}`;
}

export function jobPermissionCardCallbackKey(
  appId: string,
  jobId: string,
): string {
  return sha256Hex(JSON.stringify([appId, jobId, 'job-permission-card'])).slice(
    0,
    24,
  );
}

export function jobPermissionRecordExpiresAt(): string {
  return NEVER_EXPIRES_AT;
}

export function jobPermissionResponseId(
  needId: string,
  askingEpoch: number,
  waiterId: string,
) {
  return `job-permission-response:${sha256Hex(
    JSON.stringify([needId, askingEpoch, waiterId]),
  )}`;
}

export function canonicalAtoms(atoms: readonly string[]): string[] {
  return [...new Set(atoms.map((atom) => atom.trim()).filter(Boolean))];
}

export function cardActionTarget(
  state: JobPermissionDurabilityState,
  action: ParsedJobPermissionCardAction,
): JobPermissionCardRowSnapshot | null {
  const revision = state.card.revisions.find(
    (candidate) => candidate.revision === action.revision,
  );
  if (!revision) return null;
  if (action.rowIndex === null) {
    return (
      revision.rows.find((row) => revision.batchNeedIds.includes(row.needId)) ??
      null
    );
  }
  return revision.rows[action.rowIndex] ?? null;
}

export function recordRerunConsent(
  state: JobPermissionDurabilityState,
  need: JobPermissionNeedRecord,
  priorRunId: string,
  requestedBy: string,
  now: string,
): void {
  let barrier = state.card.rerunBarriers.find(
    (entry) => entry.priorRunId === priorRunId,
  );
  if (!barrier) {
    barrier = {
      priorRunId,
      requiredNeeds: [],
      requestedAt: now,
      requestedBy,
      enqueuedAt: null,
    };
    state.card.rerunBarriers.push(barrier);
  }
  const requiredNeeds = state.needs
    .filter(
      (candidate) =>
        !['applied', 'cancelled'].includes(candidate.state) &&
        candidate.waiters.some((waiter) => waiter.runId === priorRunId),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!requiredNeeds.some((candidate) => candidate.id === need.id)) {
    requiredNeeds.push(need);
  }
  for (const requiredNeed of requiredNeeds) {
    if (
      barrier.requiredNeeds.some(
        (required) =>
          required.needId === requiredNeed.id &&
          required.askingEpoch === requiredNeed.askingEpoch,
      )
    ) {
      continue;
    }
    barrier.requiredNeeds.push({
      needId: requiredNeed.id,
      askingEpoch: requiredNeed.askingEpoch,
    });
  }
}

export function removePendingRerunBarriersForNeed(
  card: JobPermissionCardRecord,
  needId: string,
  askingEpoch: number,
): void {
  card.rerunBarriers = card.rerunBarriers.filter(
    (barrier) =>
      barrier.enqueuedAt ||
      !barrier.requiredNeeds.some(
        (required) =>
          required.needId === needId && required.askingEpoch === askingEpoch,
      ),
  );
}

export function budgetForRun(
  card: JobPermissionCardRecord,
  runId: string,
): JobPermissionPendingBudget {
  let budget = card.pendingBudgets.find(
    (candidate) => candidate.runId === runId,
  );
  if (!budget) {
    budget = {
      runId,
      openCount: 0,
      accumulatedMs: 0,
      hostBootId: null,
      lastMonotonicMs: null,
    };
    card.pendingBudgets.push(budget);
  }
  return budget;
}

export function openPendingBudget(
  budget: JobPermissionPendingBudget,
  hostBootId: string,
  monotonicMs: number,
) {
  advancePendingBudget(
    budget,
    hostBootId,
    monotonicMs,
    MAX_JOB_PERMISSION_WAIT_MS,
  );
  budget.openCount += 1;
}

export function closePendingBudget(
  budget: JobPermissionPendingBudget,
  hostBootId: string,
  monotonicMs: number,
) {
  advancePendingBudget(
    budget,
    hostBootId,
    monotonicMs,
    MAX_JOB_PERMISSION_WAIT_MS,
  );
  budget.openCount = Math.max(0, budget.openCount - 1);
}

export function advancePendingBudget(
  budget: JobPermissionPendingBudget,
  hostBootId: string,
  monotonicMs: number,
  maxDeltaMs: number,
): void {
  if (
    budget.hostBootId === hostBootId &&
    budget.lastMonotonicMs !== null &&
    monotonicMs < budget.lastMonotonicMs
  ) {
    return;
  }
  if (
    budget.openCount > 0 &&
    budget.hostBootId === hostBootId &&
    budget.lastMonotonicMs !== null &&
    monotonicMs >= budget.lastMonotonicMs
  ) {
    budget.accumulatedMs = Math.min(
      MAX_JOB_PERMISSION_WAIT_MS,
      budget.accumulatedMs +
        Math.min(Math.max(0, maxDeltaMs), monotonicMs - budget.lastMonotonicMs),
    );
  }
  budget.hostBootId = hostBootId;
  budget.lastMonotonicMs = monotonicMs;
}
