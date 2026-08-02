import { isAsyncTaskTerminal, } from '../domain/ports/async-tasks.js';
import { deliverPendingCallableAgentFollowUp } from './async-delegated-agent-follow-up.js';
import { drainQueuedAsyncTasks } from './async-command-task-drainer.js';
export function drainQueuedCommandTasks(input) {
    return drainQueuedAsyncTasks({
        ...input,
        limits: { perApp: 4, perAgent: 2 },
    });
}
export function delegatedAgentFailureResult(output, latestResult, attemptedAction) {
    const partialResult = output.result ?? latestResult;
    return {
        outputSummary: partialResult,
        errorSummary: output.error ?? 'Delegated agent run failed.',
        failure: output.failure ?? {
            type: 'execution',
            attemptedAction,
            partialResult,
        },
    };
}
export function isAgentFacingTask(task) {
    return task.kind !== 'session_compaction';
}
export function delegatedCompletion(task) {
    const status = task.status;
    if (!isAsyncTaskTerminal(status)) {
        throw new Error(`Delegated task ${task.id} is not terminal.`);
    }
    return {
        taskId: task.id,
        status: status,
        result: task.outputSummary || `delegated task ${status}`,
        ...(task.errorSummary ? { error: task.errorSummary } : {}),
    };
}
export async function recoverPendingDelegatedAgentFollowUps(input) {
    const tasks = await input.repository.listTasks({
        appId: input.appId,
        agentId: input.agentId,
        kind: 'delegated_agent',
        statuses: ['completed', 'failed', 'cancelled', 'timed_out'],
        order: 'newest_first',
        limit: input.limit ?? 100,
    });
    let delivered = 0;
    for (const task of tasks) {
        if (await deliverPendingCallableAgentFollowUp({
            task,
            repository: input.repository,
            messageRepository: input.completionMessageRepository,
        }).catch(() => false)) {
            delivered += 1;
        }
    }
    return delivered;
}
