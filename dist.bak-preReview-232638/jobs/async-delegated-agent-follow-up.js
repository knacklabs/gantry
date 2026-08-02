import { isAsyncTaskTerminal, } from '../domain/ports/async-tasks.js';
import { boundDelegatedTaskContextResult } from '../shared/delegated-task-result-policy.js';
import { nowIso } from '../shared/time/datetime.js';
const FOLLOW_UP_KEY = 'callableAgentFollowUp';
export function isCallableAgentDelegatedTask(task) {
    return (task.kind === 'delegated_agent' &&
        task.authoritySnapshotJson.toolName === 'AgentDelegation');
}
export function hasPendingCallableAgentFollowUp(task) {
    return Boolean(isCallableAgentDelegatedTask(task) &&
        readFollowUpState(task.privateCorrelationJson));
}
export function hasDeliveredCallableAgentFollowUp(task) {
    const value = task.receiptJson?.callableAgentFollowUp;
    return Boolean(value?.deliveredAt);
}
export async function markCallableAgentAsyncFallback(input) {
    let task = input.task;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (isAsyncTaskTerminal(task.status))
            return task;
        const existing = readFollowUpState(task.privateCorrelationJson);
        if (existing)
            return task;
        const pendingAt = nowIso();
        const updated = await input.repository.transitionTask({
            taskId: task.id,
            leaseToken: task.leaseToken,
            fencingVersion: task.fencingVersion,
            status: task.status,
            now: pendingAt,
            expectedUpdatedAt: task.updatedAt,
            expectedPrivateCorrelationJson: task.privateCorrelationJson,
            privateCorrelationJson: {
                ...task.privateCorrelationJson,
                [FOLLOW_UP_KEY]: { pendingAt },
            },
        });
        if (updated)
            return updated;
        const latest = await input.repository.getTask(task.id);
        if (!latest)
            throw new Error('Delegated task disappeared before fallback.');
        task = latest;
    }
    throw new Error('Could not persist delegated task async fallback.');
}
export async function deliverPendingCallableAgentFollowUp(input) {
    const { task, messageRepository } = input;
    if (!messageRepository?.storeMessageWithLiveAdmission ||
        !isAsyncTaskTerminal(task.status) ||
        !hasPendingCallableAgentFollowUp(task) ||
        hasDeliveredCallableAgentFollowUp(task)) {
        return false;
    }
    const conversationId = task.conversationId?.trim();
    if (!conversationId)
        return false;
    const providerAccountId = stringValue(task.privateCorrelationJson.providerAccountId);
    const timestamp = nowIso();
    const messageId = `callable-agent-follow-up:${task.id}`;
    const message = {
        id: messageId,
        external_message_id: messageId,
        chat_jid: conversationId,
        agentId: task.agentId,
        sender: 'gantry:callable-agent',
        sender_name: 'Gantry',
        content: callableAgentFollowUpText(task),
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        ...(providerAccountId ? { providerAccountId } : {}),
        ...(task.threadId ? { thread_id: task.threadId } : {}),
    };
    const admitted = await messageRepository.storeMessageWithLiveAdmission(message, {
        appId: task.appId,
        agentId: task.agentId,
        providerAccountId,
        triggerDecision: {
            source: 'callable_agent_follow_up',
            requiresTrigger: false,
            taskId: task.id,
        },
        now: timestamp,
    });
    if (!admitted)
        return false;
    const receipt = task.receiptJson;
    if (!receipt)
        return true;
    await input.repository.updateTaskReceipt(task.id, {
        ...receipt,
        callableAgentFollowUp: { deliveredAt: timestamp },
    }, timestamp);
    return true;
}
export function callableAgentFollowUpText(task) {
    const status = task.status;
    const detail = status === 'completed'
        ? task.outputSummary || 'Delegated task completed.'
        : task.errorSummary || task.outputSummary || `Delegated task ${status}.`;
    const label = status === 'completed' ? 'Result' : 'Reason';
    return boundDelegatedTaskContextResult([
        `Callable agent task ${status} after being queued.`,
        `Task ID: ${task.id}`,
        `${label}:`,
        detail,
    ].join('\n'), task.id);
}
function readFollowUpState(value) {
    const state = value[FOLLOW_UP_KEY];
    if (!state || typeof state !== 'object' || Array.isArray(state))
        return null;
    const pendingAt = state.pendingAt;
    return typeof pendingAt === 'string' && pendingAt ? { pendingAt } : null;
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
