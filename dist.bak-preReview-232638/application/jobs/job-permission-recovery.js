import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { evaluateJobReadiness, SETUP_REQUIRED_PAUSE_REASON, } from './job-readiness-service.js';
import { agentIdForJobWorkspaceKey } from './job-tool-policy.js';
import { nowIso } from '../../shared/time/datetime.js';
export async function recheckSetupPausedJobsAfterCapabilityUpdate(input) {
    const candidates = await listCandidateJobs(input);
    const now = input.clock?.now() ?? nowIso();
    const queued = [];
    const stillBlocked = [];
    for (const job of candidates) {
        if (!isSetupPausedJob(job))
            continue;
        if (job.recovery_intent?.state === 'running') {
            stillBlocked.push({
                jobId: job.id,
                name: job.name,
                state: 'still_blocked',
                nextAction: 'Recovery is already running for this job.',
            });
            await publishRecheckEvent(input, job, 'still_blocked', job.setup_state);
            continue;
        }
        const readiness = await evaluateJobReadiness({
            job,
            appId: input.appId,
            agentId: agentIdForJobWorkspaceKey(input.sourceAgentFolder),
            toolRepository: input.toolRepository,
            skillRepository: input.skillRepository,
            mcpServerRepository: input.mcpServerRepository,
            capabilitySecretRepository: input.capabilitySecretRepository,
            credentialBroker: input.credentialBroker,
            getBrowserStatus: input.getBrowserStatus,
            clock: input.clock,
        });
        if (readiness.ready) {
            await input.opsRepository.updateJob(job.id, {
                status: 'active',
                pause_reason: null,
                next_run: now,
                setup_state: readiness.setupState,
                recovery_intent: null,
                lease_run_id: null,
                lease_expires_at: null,
            });
            input.scheduler.requestSchedulerSync(job.id);
            queued.push({ jobId: job.id, name: job.name, state: 'queued' });
            await publishRecheckEvent(input, job, 'queued', readiness.setupState);
            continue;
        }
        await input.opsRepository.updateJob(job.id, {
            status: 'paused',
            pause_reason: SETUP_REQUIRED_PAUSE_REASON,
            next_run: null,
            setup_state: readiness.setupState,
            lease_run_id: null,
            lease_expires_at: null,
        });
        stillBlocked.push({
            jobId: job.id,
            name: job.name,
            state: 'still_blocked',
            nextAction: readiness.setupState.blockers[0]?.nextAction,
        });
        await publishRecheckEvent(input, job, 'still_blocked', readiness.setupState);
    }
    return {
        checked: queued.length + stillBlocked.length,
        queued,
        stillBlocked,
    };
}
async function listCandidateJobs(input) {
    if (input.jobId) {
        const job = await input.opsRepository.getJobById(input.jobId);
        return job && jobMatchesCapabilityRecoveryScope(job, input) ? [job] : [];
    }
    const filters = {
        statuses: ['paused'],
        workspaceKey: input.sourceAgentFolder,
        limit: 100,
    };
    if (input.conversationJid)
        filters.conversationJid = input.conversationJid;
    return input.opsRepository.listJobs(filters);
}
function jobMatchesCapabilityRecoveryScope(job, input) {
    if (job.workspace_key !== input.sourceAgentFolder)
        return false;
    const executionContext = job.execution_context;
    if (executionContext?.workspaceKey &&
        executionContext.workspaceKey !== input.sourceAgentFolder) {
        return false;
    }
    if (!input.conversationJid)
        return true;
    return executionContext?.conversationJid === input.conversationJid;
}
function isSetupPausedJob(job) {
    return (job.status === 'paused' &&
        job.pause_reason === SETUP_REQUIRED_PAUSE_REASON &&
        job.setup_state?.state !== 'ready');
}
async function publishRecheckEvent(input, job, outcome, setupState) {
    if (!input.publishRuntimeEvent || !input.appId)
        return;
    try {
        await input.publishRuntimeEvent({
            appId: input.appId,
            eventType: RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
            actor: 'permission',
            jobId: job.id,
            conversationId: job.execution_context?.conversationJid,
            threadId: (job.execution_context?.threadId ?? job.thread_id),
            payload: {
                jobId: job.id,
                permissionRecovery: outcome,
                setup_state: setupState?.state,
                blocker_fingerprint: setupState?.fingerprint,
            },
        });
    }
    catch {
        // Rechecking paused setup must not fail because telemetry is unavailable.
    }
}
