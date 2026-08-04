import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';
export function buildJobRecoveryIntent(input) {
    const blocker = primaryRecoveryBlocker(input.setupState);
    const now = input.now ?? nowIso();
    const dedupeKey = stableSha256Json({
        jobId: input.job.id,
        setupFingerprint: input.setupState.fingerprint,
        source: normalizedDedupeSource(input.source),
        requirementType: blocker?.requirementType ?? null,
        requirementId: blocker?.requirementId ?? null,
    });
    const existing = input.job.recovery_intent?.dedupe_key === dedupeKey
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
export async function createJobRecoveryIntent(input) {
    const intent = buildJobRecoveryIntent({
        job: input.job,
        setupState: input.setupState,
        source: input.source,
        runId: input.runId,
        now: input.now,
    });
    const existing = input.job.recovery_intent;
    const created = existing?.dedupe_key !== intent.dedupe_key || existing.state === 'failed';
    const nextIntent = created && existing?.dedupe_key === intent.dedupe_key
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
export async function transitionJobRecoveryIntent(input) {
    const current = input.job.recovery_intent;
    if (!current || current.dedupe_key !== input.dedupeKey)
        return null;
    const next = {
        ...current,
        state: input.state,
        updated_at: input.now ?? nowIso(),
        attempts: input.state === 'running' ? current.attempts + 1 : current.attempts,
        last_error: input.error === undefined
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
function primaryRecoveryBlocker(setupState) {
    return setupState.blockers[0];
}
function recoveryKindForSetup(source, setupState, blocker) {
    if (source === 'permission_timeout')
        return 'permission_timeout';
    if (source === 'permission_denied')
        return 'permission_denied';
    if (setupState.state === 'missing_capability' ||
        blocker?.state === 'missing_capability') {
        return 'missing_capability';
    }
    return 'setup_required';
}
function normalizedDedupeSource(source) {
    if (source === 'final_setup')
        return 'setup';
    if (source === 'preflight_setup')
        return 'setup';
    if (source === 'transient_permission')
        return 'permission_denied';
    return source;
}
