import type { Job } from '../../../../domain/repositories/domain-types.js';
import type { CanonicalJobCoordinationUpdate } from '../repositories/canonical-job-coordination.postgres.js';

export function parseSetupState(input: unknown): Job['setup_state'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const state = normalizeString(record.state);
  if (
    state !== 'ready' &&
    state !== 'missing_capability' &&
    state !== 'broker_unreachable' &&
    state !== 'credential_unknown' &&
    state !== 'browser_login_may_be_required' &&
    state !== 'mcp_missing_credential'
  ) {
    return undefined;
  }
  const checkedAt = normalizeString(record.checked_at ?? record.checkedAt);
  const fingerprint = normalizeString(record.fingerprint);
  if (!checkedAt || !fingerprint) return undefined;
  const blockers = Array.isArray(record.blockers)
    ? record.blockers.flatMap((item) => parseSetupBlocker(item))
    : [];
  return {
    state,
    checked_at: checkedAt,
    fingerprint,
    blockers,
    notified_fingerprint:
      normalizeString(
        record.notified_fingerprint ?? record.notifiedFingerprint,
      ) ?? null,
  };
}

export function parseRequiredCapabilities(
  input: unknown,
): Job['required_capabilities'] {
  if (!Array.isArray(input)) return undefined;
  const ids = input
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));
  if (ids.length === 0) return [];
  return [...new Set(ids)].sort();
}

function parseSetupBlocker(
  input: unknown,
): NonNullable<Job['setup_state']>['blockers'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const state = normalizeString(record.state);
  if (
    state !== 'missing_capability' &&
    state !== 'broker_unreachable' &&
    state !== 'credential_unknown' &&
    state !== 'browser_login_may_be_required' &&
    state !== 'mcp_missing_credential'
  ) {
    return [];
  }
  const requirementType = normalizeRequirementType(record.requirementType);
  const message = normalizeString(record.message);
  const nextAction = normalizeString(record.nextAction);
  const requirementId = normalizeString(record.requirementId);
  if (!requirementType || !message || !nextAction || !requirementId) return [];
  return [
    {
      state,
      requirementType,
      requirementId,
      message,
      nextAction,
      ...(typeof record.grantable === 'boolean'
        ? { grantable: record.grantable }
        : {}),
    },
  ];
}

function normalizeRequirementType(
  input: unknown,
):
  | NonNullable<Job['setup_state']>['blockers'][number]['requirementType']
  | null {
  const value = normalizeString(input);
  return value === 'tool' ||
    value === 'semantic_capability' ||
    value === 'browser' ||
    value === 'mcp_server' ||
    value === 'credential' ||
    value === 'local_cli'
    ? value
    : null;
}

function normalizeString(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function coordinationUpdateFromJob(
  job: Partial<Job>,
  options?: { incrementConsecutiveFailures?: boolean },
): CanonicalJobCoordinationUpdate {
  return {
    ...(options?.incrementConsecutiveFailures
      ? { incrementConsecutiveFailures: true }
      : job.consecutive_failures !== undefined
        ? { consecutiveFailures: job.consecutive_failures }
        : {}),
    ...(job.max_consecutive_failures !== undefined
      ? { maxConsecutiveFailures: job.max_consecutive_failures }
      : {}),
    ...(job.pause_reason !== undefined
      ? { pauseReason: job.pause_reason }
      : {}),
    ...(job.setup_state !== undefined
      ? { setupState: parseSetupState(job.setup_state) ?? null }
      : {}),
  };
}
