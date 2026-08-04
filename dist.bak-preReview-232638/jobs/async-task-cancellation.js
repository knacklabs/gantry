import { nowIso } from '../shared/time/datetime.js';
import { cancelledReceipt } from './async-command-task-receipts.js';
export async function refreshDelegatedCancellationReceipt(input) {
    const remaining = await input.cancelChildTasks(input.parent);
    if (!remaining.ok)
        return;
    const childCancelledCount = input.alreadyCancelled + remaining.cancelled;
    if (childCancelledCount === 0)
        return;
    const latest = await input.repository.getTask(input.parent.id);
    await input.repository.updateTaskReceipt(input.parent.id, {
        ...cancelledReceipt(input.parent, childCancelledCount),
        ...(latest?.receiptJson?.callableAgentFollowUp
            ? {
                callableAgentFollowUp: latest.receiptJson.callableAgentFollowUp,
            }
            : {}),
    }, nowIso());
}
export async function cancelQueuedTask(input) {
    const now = nowIso();
    const cancelled = await (input.transitionTask ??
        input.repository.transitionTask.bind(input.repository))({
        taskId: input.task.id,
        leaseToken: input.task.leaseToken,
        fencingVersion: input.task.fencingVersion,
        status: 'cancelled',
        now,
        terminalAt: now,
        receiptJson: cancelledReceipt(input.task),
    });
    return cancelled
        ? { ok: true, message: 'Task was cancelled. Nothing else changed.' }
        : {
            ok: false,
            message: 'Task is already finished and cannot be cancelled.',
        };
}
