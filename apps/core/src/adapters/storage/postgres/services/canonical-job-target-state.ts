import type { Job } from '../../../../domain/repositories/domain-types.js';
import type {
  JobSetupAction,
  JobSetupBlocker,
  JobSetupReadinessState,
} from '../../../../domain/job-types.js';
import {
  compareJobSetupBlockers,
  jobSetupActionIdentity,
} from '../../../../shared/job-setup-action.js';
import { permissionAuthorityAddition } from '../../../../domain/permission-decision.js';
import type { CanonicalJobCoordinationUpdate } from '../repositories/canonical-job-coordination.postgres.js';

const SETUP_STATES = new Set<JobSetupReadinessState>([
  'ready',
  'missing_capability',
  'broker_unreachable',
  'credential_unknown',
  'browser_login_may_be_required',
  'mcp_missing_credential',
]);
const BLOCKER_TYPES = new Set<JobSetupBlocker['type']>([
  'tool',
  'semantic_capability',
  'browser',
  'mcp_server',
  'credential',
  'local_cli',
]);
export function parseSetupState(
  input: unknown,
  jobId = 'unknown',
): Job['setup_state'] {
  if (input === undefined || input === null) return undefined;
  const record = strictRecord(input, jobId, 'setup_state');
  requireExactKeys(record, jobId, 'setup_state', [
    'state',
    'checked_at',
    'fingerprint',
    'blockers',
    'notified_fingerprint',
  ]);
  if (!Object.hasOwn(record, 'notified_fingerprint')) {
    remediation(jobId, 'setup_state.notified_fingerprint');
  }
  const state = requiredString(record.state, jobId, 'setup_state.state');
  if (!SETUP_STATES.has(state as JobSetupReadinessState)) {
    remediation(jobId, `setup_state.state=${JSON.stringify(record.state)}`);
  }
  const checkedAt = requiredString(
    record.checked_at,
    jobId,
    'setup_state.checked_at',
  );
  const fingerprint = requiredString(
    record.fingerprint,
    jobId,
    'setup_state.fingerprint',
  );
  if (!Array.isArray(record.blockers)) {
    remediation(jobId, 'setup_state.blockers');
  }
  const blockers = record.blockers.map((item, index) =>
    parseSetupBlocker(item, jobId, index),
  );
  if ((state === 'ready') !== (blockers.length === 0)) {
    remediation(jobId, 'setup_state ready/blockers invariant');
  }
  const identities = blockers.map((blocker) =>
    jobSetupActionIdentity(blocker.action),
  );
  if (new Set(identities).size !== identities.length) {
    remediation(jobId, 'setup_state duplicate action identity');
  }
  const highestPriority = [...blockers].sort(compareJobSetupBlockers)[0];
  if (highestPriority?.state !== state && state !== 'ready') {
    remediation(jobId, 'setup_state top-level priority');
  }
  // Review R1: consumers read blockers[0] as the primary action, so stored
  // order MUST be canonical - the first blocker carries the highest-priority
  // action identity, not merely a matching state.
  if (
    blockers.length > 0 &&
    highestPriority &&
    jobSetupActionIdentity(blockers[0]!.action) !==
      jobSetupActionIdentity(highestPriority.action)
  ) {
    remediation(jobId, 'setup_state blocker order');
  }
  const notified = record.notified_fingerprint;
  if (
    notified !== null &&
    notified !== undefined &&
    typeof notified !== 'string'
  ) {
    remediation(jobId, 'setup_state.notified_fingerprint');
  }
  return {
    state: state as JobSetupReadinessState,
    checked_at: checkedAt,
    fingerprint,
    blockers,
    notified_fingerprint: typeof notified === 'string' ? notified : null,
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
  jobId: string,
  index: number,
): JobSetupBlocker {
  const fragment = `setup_state.blockers[${index}]`;
  const record = strictRecord(input, jobId, fragment);
  requireExactKeys(record, jobId, fragment, [
    'state',
    'type',
    'id',
    'summary',
    'action',
  ]);
  const state = requiredString(record.state, jobId, `${fragment}.state`);
  if (state === 'ready' || !SETUP_STATES.has(state as JobSetupReadinessState)) {
    remediation(jobId, `${fragment}.state`);
  }
  const type = requiredString(record.type, jobId, `${fragment}.type`);
  if (!BLOCKER_TYPES.has(type as JobSetupBlocker['type'])) {
    remediation(jobId, `${fragment}.type`);
  }
  return {
    state: state as JobSetupBlocker['state'],
    type: type as JobSetupBlocker['type'],
    id: requiredString(record.id, jobId, `${fragment}.id`),
    summary: requiredString(record.summary, jobId, `${fragment}.summary`),
    action: parseSetupAction(record.action, jobId, `${fragment}.action`),
  };
}

function parseSetupAction(
  input: unknown,
  jobId: string,
  fragment: string,
): JobSetupAction {
  const record = strictRecord(input, jobId, fragment);
  if (record.kind === 'instruction') {
    requireExactKeys(record, jobId, fragment, ['kind', 'text']);
    return {
      kind: 'instruction',
      text: requiredString(record.text, jobId, `${fragment}.text`),
    };
  }
  if (record.kind === 'fix_proposal') {
    requireExactKeys(record, jobId, fragment, ['kind', 'proposalId']);
    return {
      kind: 'fix_proposal',
      proposalId: requiredString(
        record.proposalId,
        jobId,
        `${fragment}.proposalId`,
      ),
    };
  }
  if (record.kind === 'approve_grant') {
    requireExactKeys(record, jobId, fragment, ['kind', 'grant']);
    const grantRecord = strictRecord(record.grant, jobId, `${fragment}.grant`);
    requireExactKeys(grantRecord, jobId, `${fragment}.grant`, [
      'type',
      'behavior',
      'rules',
      'destination',
    ]);
    // The setup approval path executes only plain addRules grants without an
    // explicit destination - the boundary rejects variants no path can
    // complete rather than storing a card promise that cannot be kept
    // (review R10; assumption ledger).
    if (grantRecord.type !== 'addRules') {
      remediation(jobId, `${fragment}.grant.type`);
    }
    if (grantRecord.destination !== undefined) {
      remediation(jobId, `${fragment}.grant.destination`);
    }
    if (!Array.isArray(grantRecord.rules)) {
      remediation(jobId, `${fragment}.grant.rules`);
    }
    grantRecord.rules.forEach((rule, index) => {
      const ruleFragment = `${fragment}.grant.rules[${index}]`;
      const ruleRecord = strictRecord(rule, jobId, ruleFragment);
      requireExactKeys(ruleRecord, jobId, ruleFragment, [
        'toolName',
        'ruleContent',
      ]);
    });
    const grant = permissionAuthorityAddition(
      record.grant as Parameters<typeof permissionAuthorityAddition>[0],
    );
    if (!grant) remediation(jobId, `${fragment}.grant`);
    return { kind: 'approve_grant', grant };
  }
  remediation(jobId, `${fragment}.kind`);
}

function requireExactKeys(
  record: Record<string, unknown>,
  jobId: string,
  fragment: string,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unexpected) remediation(jobId, `${fragment}.${unexpected}`);
}

function strictRecord(
  input: unknown,
  jobId: string,
  fragment: string,
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    remediation(jobId, fragment);
  }
  return input as Record<string, unknown>;
}

function requiredString(
  input: unknown,
  jobId: string,
  fragment: string,
): string {
  const value = normalizeString(input);
  if (!value) remediation(jobId, fragment);
  return value;
}

function remediation(jobId: string, fragment: string): never {
  throw new Error(
    `Job ${jobId} has malformed setup_state at ${fragment}; run the JOBFLOW-1-S2B setup-state remediation migration before starting Gantry.`,
  );
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
      ? { setupState: parseSetupState(job.setup_state, job.id) ?? null }
      : {}),
  };
}
