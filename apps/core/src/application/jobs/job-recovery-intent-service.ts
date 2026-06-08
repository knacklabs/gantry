import type {
  Job,
  JobRecoveryIntent,
  JobRecoveryIntentKind,
  JobRecoveryIntentState,
  JobSetupBlocker,
  JobSetupState,
} from '../../domain/types.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';

export type JobRecoveryIntentSource =
  | 'preflight_setup'
  | 'final_setup'
  | 'permission_denied'
  | 'permission_timeout'
  | 'transient_permission';

export interface JobRecoveryIntentUpsertResult {
  intent: JobRecoveryIntent;
  created: boolean;
}

export function buildJobRecoveryIntent(input: {
  job: Pick<Job, 'id' | 'recovery_intent'>;
  setupState: JobSetupState;
  source: JobRecoveryIntentSource;
  runId?: string | null;
  now?: string;
}): JobRecoveryIntent {
  const blocker = primaryRecoveryBlocker(input.setupState);
  const now = input.now ?? nowIso();
  const dedupeKey = stableSha256Json({
    jobId: input.job.id,
    setupFingerprint: input.setupState.fingerprint,
    source: normalizedDedupeSource(input.source),
    requirementType: blocker?.requirementType ?? null,
    requirementId: blocker?.requirementId ?? null,
  });
  const existing =
    input.job.recovery_intent?.dedupe_key === dedupeKey
      ? input.job.recovery_intent
      : undefined;
  return {
    kind: recoveryKindForSetup(input.source, input.setupState, blocker),
    state: existing?.state ?? 'pending',
    dedupe_key: dedupeKey,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    source_run_id: input.runId ?? existing?.source_run_id ?? null,
    setup_fingerprint: input.setupState.fingerprint,
    requirement_type: blocker?.requirementType ?? null,
    requirement_id: blocker?.requirementId ?? null,
    next_action: blocker?.nextAction ?? null,
    attempts: existing?.attempts ?? 0,
    last_error: existing?.last_error ?? null,
  };
}

export async function createJobRecoveryIntent(input: {
  job: Job;
  setupState: JobSetupState;
  source: JobRecoveryIntentSource;
  runId?: string | null;
  opsRepository: Pick<RuntimeJobRepository, 'updateJob'>;
  now?: string;
}): Promise<JobRecoveryIntentUpsertResult> {
  const intent = buildJobRecoveryIntent({
    job: input.job,
    setupState: input.setupState,
    source: input.source,
    runId: input.runId,
    now: input.now,
  });
  const existing = input.job.recovery_intent;
  const created =
    existing?.dedupe_key !== intent.dedupe_key || existing.state === 'failed';
  const nextIntent: JobRecoveryIntent =
    created && existing?.dedupe_key === intent.dedupe_key
      ? { ...intent, state: 'pending' }
      : intent;
  if (!created) {
    return { intent: existing, created: false };
  }
  await input.opsRepository.updateJob(input.job.id, {
    recovery_intent: nextIntent,
  });
  return { intent: nextIntent, created: true };
}

export function shouldRunRecoveryIntent(
  job: Pick<Job, 'recovery_intent'>,
  dedupeKey: string,
): boolean {
  return (
    job.recovery_intent?.dedupe_key === dedupeKey &&
    (job.recovery_intent.state === 'pending' ||
      job.recovery_intent.state === 'failed')
  );
}

export async function transitionJobRecoveryIntent(input: {
  job: Job;
  dedupeKey: string;
  state: JobRecoveryIntentState;
  opsRepository: Pick<RuntimeJobRepository, 'updateJob'>;
  now?: string;
  error?: string | null;
}): Promise<JobRecoveryIntent | null> {
  const current = input.job.recovery_intent;
  if (!current || current.dedupe_key !== input.dedupeKey) return null;
  const next: JobRecoveryIntent = {
    ...current,
    state: input.state,
    updated_at: input.now ?? nowIso(),
    attempts:
      input.state === 'running' ? current.attempts + 1 : current.attempts,
    last_error:
      input.error === undefined
        ? current.last_error
        : input.error
          ? input.error.slice(0, 500)
          : null,
  };
  await input.opsRepository.updateJob(input.job.id, {
    recovery_intent: next,
  });
  return next;
}

function primaryRecoveryBlocker(
  setupState: JobSetupState,
): JobSetupBlocker | undefined {
  return setupState.blockers[0];
}

function recoveryKindForSetup(
  source: JobRecoveryIntentSource,
  setupState: JobSetupState,
  blocker: JobSetupBlocker | undefined,
): JobRecoveryIntentKind {
  if (source === 'permission_timeout') return 'permission_timeout';
  if (source === 'permission_denied') return 'permission_denied';
  if (
    setupState.state === 'missing_capability' ||
    blocker?.state === 'missing_capability'
  ) {
    return 'missing_capability';
  }
  return 'setup_required';
}

function normalizedDedupeSource(source: JobRecoveryIntentSource): string {
  if (source === 'final_setup') return 'setup';
  if (source === 'preflight_setup') return 'setup';
  if (source === 'transient_permission') return 'permission_denied';
  return source;
}
