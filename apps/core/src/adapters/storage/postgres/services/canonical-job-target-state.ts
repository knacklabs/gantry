import type { Job } from '../../../../domain/repositories/domain-types.js';

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

export function parseRecoveryIntent(input: unknown): Job['recovery_intent'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const kind = normalizeString(record.kind);
  if (
    kind !== 'setup_required' &&
    kind !== 'missing_capability' &&
    kind !== 'permission_denied' &&
    kind !== 'permission_timeout'
  ) {
    return undefined;
  }
  const state = normalizeString(record.state);
  if (
    state !== 'pending' &&
    state !== 'running' &&
    state !== 'completed' &&
    state !== 'failed' &&
    state !== 'suppressed'
  ) {
    return undefined;
  }
  const dedupeKey = normalizeString(record.dedupe_key ?? record.dedupeKey);
  const createdAt = normalizeString(record.created_at ?? record.createdAt);
  const updatedAt = normalizeString(record.updated_at ?? record.updatedAt);
  if (!dedupeKey || !createdAt || !updatedAt) return undefined;
  const attempts =
    typeof record.attempts === 'number' && Number.isFinite(record.attempts)
      ? Math.max(0, Math.floor(record.attempts))
      : 0;
  return {
    kind,
    state,
    dedupe_key: dedupeKey,
    created_at: createdAt,
    updated_at: updatedAt,
    source_run_id: normalizeNullableString(
      record.source_run_id ?? record.sourceRunId,
    ),
    setup_fingerprint: normalizeNullableString(
      record.setup_fingerprint ?? record.setupFingerprint,
    ),
    requirement_type: normalizeRecoveryRequirementType(
      record.requirement_type ?? record.requirementType,
    ),
    requirement_id: normalizeNullableString(
      record.requirement_id ?? record.requirementId,
    ),
    next_action: normalizeNullableString(
      record.next_action ?? record.nextAction,
    ),
    attempts,
    last_error: normalizeNullableString(record.last_error ?? record.lastError),
  };
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
  const requirementType = normalizeRecoveryRequirementType(
    record.requirementType,
  );
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
    },
  ];
}

function normalizeRecoveryRequirementType(
  input: unknown,
): NonNullable<Job['recovery_intent']>['requirement_type'] {
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

function normalizeNullableString(input: unknown): string | null {
  return input === null || input === undefined
    ? null
    : (normalizeString(input) ?? null);
}
