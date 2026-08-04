import { splitAccessRequirements } from './job-access-requirements.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from './job-access.js';
import { agentIdForJobWorkspaceKey, resolveAgentToolBindings, resolveJobToolPolicy, } from './job-tool-policy.js';
import { schedulerJobStaleness, } from '../../shared/scheduler-job-staleness.js';
import { buildJobToolAccessView, } from '../../shared/tool-access-view.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { parseAutonomousToolDenial, } from '../../shared/autonomous-tool-denial.js';
import { setupActionLabel, setupActionLabelFromNextAction, setupReadinessLabel, } from '../../shared/job-setup-labels.js';
export async function buildJobVisibilityMetadata(input) {
    const appId = input.appId ?? DEFAULT_JOB_RUNTIME_APP_ID;
    const executionContext = resolveExecutionContext(input.job);
    const notificationRoutes = resolveNotificationRoutes(input.job, executionContext);
    const agentId = agentIdForJobWorkspaceKey(input.job.workspace_key);
    const policy = await resolveJobToolPolicy({
        job: input.job,
        appId,
        agentId,
        toolRepository: input.toolRepository,
        skillRepository: input.skillRepository,
    });
    const nowMs = input.nowMs ?? currentTimeMs();
    const staleness = schedulerJobStaleness(input.job, nowMs);
    const runs = typeof input.ops.listJobRuns === 'function'
        ? await input.ops.listJobRuns(input.job.id, input.recentRunLimit ?? 5)
        : [];
    const health = buildJobHealth({
        job: input.job,
        runs,
        staleness,
        nowMs,
    });
    const setup = setupMetadataForJob(input.job);
    const recovery = recoveryMetadataForJob(input.job);
    const displayLabels = deriveJobDisplayLabels({
        executionContext,
        notificationRoutes,
        setup,
        health,
    });
    return {
        executionContext,
        notificationRoutes,
        target: {
            appId,
            agentId,
            workspaceKey: input.job.workspace_key,
            conversationJids: dedupeConversationJids(notificationRoutes),
            threadId: executionContext.threadId,
        },
        ...displayLabels,
        promptPreview: promptPreview(input.job.prompt),
        fullPrompt: input.job.prompt,
        inheritedTools: policy.inheritedTools,
        effectiveAllowedTools: policy.effectiveAllowedTools,
        ...splitAccessRequirements(input.job.access_requirements),
        toolAccess: buildJobToolAccessView({
            inheritedAgentTools: policy.inheritedTools,
            effectiveAllowedTools: policy.effectiveAllowedTools,
        }),
        setup,
        recovery,
        health,
        staleness,
        recentRunErrors: runs
            .filter((run) => Boolean(run.error_summary))
            .map((run) => ({
            runId: run.run_id,
            status: run.status,
            errorSummary: run.error_summary ?? '',
            endedAt: run.ended_at,
        })),
    };
}
export async function buildJobListVisibilityMetadata(input) {
    const nowMs = input.nowMs ?? currentTimeMs();
    const latestRunsByJobId = await loadLatestRunsByJobId(input.jobs, input.ops);
    const inheritedToolsByTarget = new Map();
    const loadInheritedTools = (appId, agentId) => {
        const key = `${appId}\0${agentId}`;
        let promise = inheritedToolsByTarget.get(key);
        if (!promise) {
            promise = resolveAgentToolBindings({
                repository: input.toolRepository,
                skillRepository: input.skillRepository,
                appId,
                agentId,
            });
            inheritedToolsByTarget.set(key, promise);
        }
        return promise;
    };
    return new Map(await Promise.all(input.jobs.map(async (job) => {
        const appId = input.appId ?? DEFAULT_JOB_RUNTIME_APP_ID;
        const executionContext = resolveExecutionContext(job);
        const notificationRoutes = resolveNotificationRoutes(job, executionContext);
        const agentId = agentIdForJobWorkspaceKey(job.workspace_key);
        const inheritedTools = await loadInheritedTools(appId, agentId);
        const effectiveAllowedTools = mergeUnique(inheritedTools);
        const staleness = schedulerJobStaleness(job, nowMs);
        const latestRun = latestRunsByJobId.get(job.id);
        const runs = latestRun ? [latestRun] : [];
        const setup = setupMetadataForJob(job);
        const health = buildJobHealth({
            job,
            runs,
            staleness,
            nowMs,
        });
        const displayLabels = deriveJobDisplayLabels({
            executionContext,
            notificationRoutes,
            setup,
            health,
        });
        const metadata = {
            executionContext,
            notificationRoutes,
            target: {
                appId,
                agentId,
                workspaceKey: job.workspace_key,
                conversationJids: dedupeConversationJids(notificationRoutes),
                threadId: executionContext.threadId,
            },
            ...displayLabels,
            promptPreview: promptPreview(job.prompt),
            inheritedTools,
            effectiveAllowedTools,
            ...splitAccessRequirements(job.access_requirements),
            toolAccess: buildJobToolAccessView({
                inheritedAgentTools: inheritedTools,
                effectiveAllowedTools,
            }),
            setup,
            recovery: recoveryMetadataForJob(job),
            health,
            staleness,
            recentRunErrors: runs
                .filter((run) => Boolean(run.error_summary))
                .map((run) => ({
                runId: run.run_id,
                status: run.status,
                errorSummary: run.error_summary ?? '',
                endedAt: run.ended_at,
            })),
        };
        return [job.id, metadata];
    })));
}
async function loadLatestRunsByJobId(jobs, ops) {
    if (!ops || jobs.length === 0)
        return new Map();
    return ops.listLatestJobRunsByJobIds(jobs.map((job) => job.id));
}
function promptPreview(prompt) {
    const compact = prompt.replace(/\s+/g, ' ').trim();
    return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}
function buildJobHealth(input) {
    const latestRun = input.runs[0];
    const latestSummary = latestRun?.error_summary ?? latestRun?.result_summary ?? null;
    const denial = parseAutonomousToolDenial(latestSummary) ??
        parsePermissionPauseReason(input.job.pause_reason);
    const setupBlocker = input.job.pause_reason === 'Setup required'
        ? input.job.setup_state?.blockers[0]
        : undefined;
    const leaseExpired = input.job.status === 'running' &&
        Boolean(input.job.lease_expires_at) &&
        Date.parse(input.job.lease_expires_at || '') < input.nowMs;
    const state = leaseExpired
        ? 'stale_lease'
        : setupBlocker
            ? setupBlocker.state
            : denial
                ? 'needs_permission'
                : input.job.status === 'dead_lettered'
                    ? 'dead_lettered'
                    : input.job.status === 'running' || latestRun?.status === 'running'
                        ? 'running'
                        : latestRun?.status === 'timeout'
                            ? isRestartInterruptedRun(latestSummary)
                                ? 'interrupted'
                                : 'timed_out'
                            : latestRun?.status === 'failed'
                                ? 'failed'
                                : latestRun?.status === 'completed'
                                    ? 'completed'
                                    : input.staleness === 'missed_window'
                                        ? 'missed_window'
                                        : 'ready';
    return {
        state,
        latestRunId: latestRun?.run_id ?? null,
        latestRunStatus: latestRun?.status ?? null,
        latestSummary,
        activeRunId: input.job.lease_run_id ??
            (latestRun?.status === 'running' ? latestRun.run_id : null),
        leaseExpiresAt: input.job.lease_expires_at,
        nextAction: setupBlocker?.nextAction ?? nextJobHealthAction(state, denial),
    };
}
function deriveJobDisplayLabels(input) {
    const primaryRoute = input.notificationRoutes[0];
    const ownerJid = input.executionContext.conversationJid ||
        primaryRoute?.conversationJid ||
        '';
    const deliveryJid = primaryRoute?.conversationJid ||
        input.executionContext.conversationJid ||
        '';
    const deliveryThread = primaryRoute?.threadId ?? input.executionContext.threadId;
    const blocker = input.setup.blockers[0];
    const nextActionLabel = blocker
        ? setupActionLabel(blocker)
        : input.health.nextAction
            ? setupActionLabelFromNextAction(input.health.nextAction)
            : null;
    return {
        ownerLabel: genericConversationOwnerLabel(ownerJid),
        deliveryLabel: genericConversationDeliveryLabel(deliveryJid, deliveryThread),
        setupLabel: setupReadinessLabel(input.setup.state),
        nextActionLabel,
    };
}
function genericConversationOwnerLabel(conversationJid) {
    return conversationJid.trim() ? 'Conversation' : 'Conversation';
}
function genericConversationDeliveryLabel(conversationJid, threadId) {
    if (!conversationJid.trim())
        return 'Conversation';
    return typeof threadId === 'string' && threadId.trim()
        ? 'Conversation thread'
        : 'Conversation';
}
// "Needs approval" only fits capability/permission grants; broker, credential,
// and browser-login blockers are not approvals, so they read as "Needs setup".
function setupMetadataForJob(job) {
    const setup = job.setup_state;
    const blockers = setup?.blockers ?? [];
    return {
        state: setup?.state ?? 'ready',
        checkedAt: setup?.checked_at ?? null,
        fingerprint: setup?.fingerprint ?? null,
        blockers: blockers.map((blocker) => ({
            state: blocker.state,
            message: blocker.message,
            nextAction: blocker.nextAction,
            requirementType: blocker.requirementType,
            requirementId: blocker.requirementId,
        })),
        nextAction: blockers[0]?.nextAction ?? null,
    };
}
function recoveryMetadataForJob(job) {
    const recovery = job.recovery_intent;
    return {
        state: recovery?.state ?? 'none',
        kind: recovery?.kind ?? null,
        updatedAt: recovery?.updated_at ?? null,
        attempts: recovery?.attempts ?? 0,
        requirementType: recovery?.requirement_type ?? null,
        requirementId: recovery?.requirement_id ?? null,
        nextAction: recovery?.next_action ?? null,
        lastError: recovery?.last_error ?? null,
    };
}
function parsePermissionPauseReason(value) {
    if (!value)
        return null;
    const match = value.match(/^Needs permission:\s*(\S+)/i);
    return match?.[1] ? { toolName: match[1] } : null;
}
function nextJobHealthAction(state, denial) {
    if (denial?.recoveryAction)
        return denial.recoveryAction;
    if (state === 'needs_permission' && denial?.toolName) {
        return `Approve ${neutralToolAccessLabel(denial.toolName)}, then rerun the job.`;
    }
    if (state === 'timed_out') {
        return 'Rerun with a longer job timeout if this work is expected to take more time.';
    }
    if (state === 'interrupted') {
        return 'Rerun the job when ready. If this repeats without restarts, increase the job timeout.';
    }
    if (state === 'dead_lettered') {
        return 'Fix the blocker, then use scheduler_resume_job.';
    }
    if (state === 'stale_lease') {
        return 'Wait for scheduler cleanup, then inspect the latest run.';
    }
    if (state === 'missed_window') {
        return 'Run the job now or update its schedule.';
    }
    return null;
}
function isRestartInterruptedRun(summary) {
    return /runtime restarted|gantry restarted/i.test(summary ?? '');
}
// Keep raw implementation tool ids (RunCommand, Bash, mcp__server__tool) out of
// user-facing next-action copy; map them to provider-neutral access labels.
function neutralToolAccessLabel(toolName) {
    if (toolName.startsWith('mcp__gantry__browser_') || toolName === 'Browser') {
        return 'Browser access';
    }
    if (toolName === 'RunCommand' || toolName === 'Bash') {
        return 'exact command access';
    }
    return 'the requested access';
}
function resolveExecutionContext(job) {
    const stored = job.execution_context;
    if (stored &&
        typeof stored.conversationJid === 'string' &&
        stored.conversationJid.trim() &&
        typeof stored.workspaceKey === 'string' &&
        stored.workspaceKey.trim()) {
        return {
            conversationJid: stored.conversationJid,
            threadId: stored.threadId ?? null,
            workspaceKey: stored.workspaceKey,
            sessionId: stored.sessionId === undefined ? job.session_id : stored.sessionId,
        };
    }
    const fallbackConversationJid = Array.isArray(job.notification_routes)
        ? job.notification_routes.find((route) => typeof route?.conversationJid === 'string' &&
            route.conversationJid.trim().length > 0)?.conversationJid
        : undefined;
    return {
        conversationJid: fallbackConversationJid ?? '',
        threadId: job.thread_id,
        workspaceKey: job.workspace_key,
        sessionId: job.session_id,
    };
}
function resolveNotificationRoutes(job, executionContext) {
    const stored = Array.isArray(job.notification_routes)
        ? job.notification_routes
        : [];
    const normalized = stored
        .filter((route) => typeof route?.conversationJid === 'string' &&
        route.conversationJid.trim().length > 0 &&
        typeof route?.label === 'string' &&
        route.label.trim().length > 0 &&
        (route.threadId === null || typeof route.threadId === 'string'))
        .map((route) => ({
        conversationJid: route.conversationJid.trim(),
        threadId: route.threadId ?? null,
        label: route.label.trim(),
    }));
    if (normalized.length > 0)
        return normalized;
    return [
        {
            conversationJid: executionContext.conversationJid,
            threadId: executionContext.threadId,
            label: 'primary',
        },
    ];
}
function dedupeConversationJids(routes) {
    const out = new Set();
    for (const route of routes) {
        if (route.conversationJid)
            out.add(route.conversationJid);
    }
    return [...out];
}
function mergeUnique(base) {
    const out = new Set();
    for (const item of base) {
        const value = item.trim();
        if (value)
            out.add(value);
    }
    return [...out];
}
