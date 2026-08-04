import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from './job-access.js';
import { evaluateJobReadiness, SETUP_REQUIRED_PAUSE_REASON, } from './job-readiness-service.js';
import { setupActionLabel } from '../../shared/job-setup-labels.js';
export async function evaluateManagedJobReadiness(input) {
    return evaluateJobReadiness({
        job: input.job,
        appId: await resolveJobReadinessAppId({
            deps: input.deps,
            job: input.job,
            appId: input.appId,
        }),
        agentId: input.agentId,
        toolRepository: input.deps.toolRepository,
        skillRepository: input.deps.skillRepository,
        mcpServerRepository: input.deps.mcpServerRepository,
        capabilitySecretRepository: input.deps.capabilitySecretRepository,
        credentialBroker: await input.deps.getCredentialBroker?.(),
        getBrowserStatus: input.deps.getBrowserStatus,
        clock: input.deps.clock,
    });
}
export function applyJobReadinessToUpdates(updates, readiness, options = {}) {
    updates.setup_state = readiness.setupState;
    if (!readiness.ready) {
        updates.status = 'paused';
        updates.pause_reason = SETUP_REQUIRED_PAUSE_REASON;
        updates.next_run = null;
        return;
    }
    updates.recovery_intent = null;
    if (options.clearPauseWhenActive && options.mergedStatus === 'active') {
        updates.pause_reason = null;
    }
}
export async function pauseJobForSetup(input) {
    await input.deps.ops.updateJob(input.job.id, {
        status: 'paused',
        pause_reason: SETUP_REQUIRED_PAUSE_REASON,
        next_run: null,
        setup_state: input.readiness.setupState,
        lease_run_id: null,
        lease_expires_at: null,
    });
    await recordJobSetupRequired(input);
    input.deps.scheduler.requestSchedulerSync(input.job.id);
}
export async function recordJobSetupRequired(input) {
    if (input.readiness.ready || !input.deps.runtimeEvents)
        return;
    const appSession = input.job.session_id
        ? await input.deps.control?.getAppSessionById(input.job.session_id)
        : undefined;
    const appId = appSession?.appId ?? input.appId ?? DEFAULT_JOB_RUNTIME_APP_ID;
    await input.deps.runtimeEvents.publish({
        appId: appId,
        eventType: RUNTIME_EVENT_TYPES.JOB_SETUP_REQUIRED,
        actor: 'scheduler',
        sessionId: appSession?.sessionId,
        jobId: input.job.id,
        conversationId: input.job.execution_context?.conversationJid,
        threadId: (input.job.execution_context?.threadId ??
            input.job.thread_id ??
            null),
        responseMode: appSession?.defaultResponseMode,
        webhookId: appSession?.defaultWebhookId,
        payload: {
            jobId: input.job.id,
            setup_state: input.readiness.setupState.state,
            blocker_fingerprint: input.readiness.setupState.fingerprint,
            notified: false,
            blockers: input.readiness.setupState.blockers,
        },
    });
}
export function setupBlockerDetails(setupState) {
    return setupState.blockers.map((blocker) => `${blocker.message} Action: ${setupActionLabel(blocker)}`);
}
async function resolveJobReadinessAppId(input) {
    if (input.appId)
        return input.appId;
    if (!input.job.session_id)
        return undefined;
    const session = await input.deps.control?.getAppSessionById(input.job.session_id);
    return session?.appId ?? `unresolved:${input.job.session_id}`;
}
