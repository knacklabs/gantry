import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
const TASK_EVENT_TYPE_BY_KIND = {
    started: RUNTIME_EVENT_TYPES.TASK_STARTED,
    progress: RUNTIME_EVENT_TYPES.TASK_PROGRESS,
    updated: RUNTIME_EVENT_TYPES.TASK_UPDATED,
    notification: RUNTIME_EVENT_TYPES.TASK_NOTIFICATION,
};
const TASK_LIFECYCLE_TEXT_MAX = 300;
export function buildTaskLifecycleRuntimeEvent(context, input) {
    const taskId = input.taskId.trim();
    if (!taskId)
        return null;
    return {
        ...defined({
            appId: context.appId,
            agentId: context.agentId,
            runId: context.runId,
            jobId: context.jobId,
            conversationId: context.conversationId,
            threadId: context.threadId,
            actor: context.actor ?? 'runner',
        }),
        eventType: TASK_EVENT_TYPE_BY_KIND[input.kind],
        payload: payloadFor(input.kind, { ...input, taskId }),
    };
}
function payloadFor(kind, input) {
    const base = defined({
        taskId: input.taskId,
        toolUseId: input.toolUseId,
    });
    if (kind === 'started') {
        return {
            ...base,
            ...defined({
                description: boundedText(input.description),
                subagentType: boundedText(input.subagentType),
                taskKind: taskKind(input),
                workflowName: boundedText(input.workflowName),
            }),
            skipTranscript: input.skipTranscript === true,
        };
    }
    if (kind === 'progress') {
        return {
            ...base,
            ...defined({
                description: boundedText(input.description),
                subagentType: boundedText(input.subagentType),
                taskKind: taskKind(input),
                lastToolName: boundedText(input.lastToolName),
                summary: boundedText(input.summary),
                usage: sanitizedUsage(input.usage),
            }),
        };
    }
    if (kind === 'updated') {
        return {
            ...base,
            patch: defined({
                status: taskStatus(input.patch?.status),
                description: boundedText(input.patch?.description),
                endTime: input.patch?.endTime,
                totalPausedMs: input.patch?.totalPausedMs,
                isBackgrounded: input.patch?.isBackgrounded,
                hasError: input.patch?.hasError,
            }),
        };
    }
    return {
        ...base,
        ...defined({
            status: taskStatus(input.status),
            summary: boundedText(input.summary),
            usage: sanitizedUsage(input.usage),
        }),
        skipTranscript: input.skipTranscript === true,
    };
}
function taskKind(input) {
    if (input.taskKind)
        return input.taskKind;
    const normalized = input.taskType?.trim().toLowerCase();
    if (normalized === 'async_command' ||
        normalized === 'local_bash' ||
        normalized === 'bash' ||
        normalized === 'run_command' ||
        normalized === 'command') {
        return 'async_command';
    }
    if (normalized === 'delegated_agent' ||
        normalized === 'local_agent' ||
        normalized === 'remote_agent' ||
        normalized === 'agent' ||
        normalized === 'subagent') {
        return 'delegated_agent';
    }
    return undefined;
}
function taskStatus(value) {
    if (typeof value !== 'string')
        return undefined;
    switch (value.trim().toLowerCase()) {
        case 'queued':
        case 'pending':
            return 'queued';
        case 'running':
        case 'started':
        case 'in_progress':
        case 'in-progress':
            return 'running';
        case 'needs_attention':
        case 'needs-attention':
        case 'blocked':
            return 'needs_attention';
        case 'completed':
        case 'complete':
        case 'success':
        case 'succeeded':
            return 'completed';
        case 'failed':
        case 'error':
            return 'failed';
        case 'cancelled':
        case 'canceled':
        case 'stopped':
            return 'cancelled';
        case 'timed_out':
        case 'timed-out':
        case 'timeout':
        case 'timedout':
            return 'timed_out';
        default:
            return undefined;
    }
}
function boundedText(value) {
    if (typeof value !== 'string')
        return undefined;
    return value.length > TASK_LIFECYCLE_TEXT_MAX
        ? value.slice(0, TASK_LIFECYCLE_TEXT_MAX)
        : value;
}
function sanitizedUsage(usage) {
    if (!usage)
        return undefined;
    const out = defined({
        totalTokens: finite(usage.totalTokens),
        toolUses: finite(usage.toolUses),
        durationMs: finite(usage.durationMs),
    });
    return Object.keys(out).length > 0 ? out : undefined;
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}
function defined(input) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
