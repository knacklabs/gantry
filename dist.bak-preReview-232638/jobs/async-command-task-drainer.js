import { randomUUID } from 'node:crypto';
import { nowIso } from '../shared/time/datetime.js';
import { executeDelegatedAgentTask } from './async-delegated-agent-task.js';
import { withLocalAdmissionLock } from './async-command-task-helpers.js';
import { hasAsyncTaskRunningCapacity } from './async-task-running-capacity.js';
export async function drainQueuedAsyncTasks(input) {
    await withLocalAdmissionLock(input.repository, async () => {
        for (const execution of [...input.pending.values()]) {
            const hasCapacity = await hasAsyncTaskRunningCapacity(input.repository, execution.task, input.limits);
            if (!hasCapacity)
                continue;
            const claimed = (await input.repository.claimQueuedTask?.({
                taskId: execution.task.id,
                leaseToken: randomUUID(),
                now: nowIso(),
                maxRunningPerApp: input.limits.perApp,
                maxRunningPerAgent: input.limits.perAgent,
            })) ?? execution.task;
            if (claimed.status !== 'running' && input.repository.claimQueuedTask) {
                continue;
            }
            input.pending.delete(execution.task.id);
            input.active.set(claimed.id, execution.controller);
            if (execution.delegated) {
                void executeDelegatedAgentTask({
                    task: claimed,
                    taskInput: execution.delegated.taskInput,
                    controller: execution.controller,
                    repository: input.repository,
                    active: input.active,
                    cancelLinkedChildTasks: execution.delegated.cancelLinkedChildTasks,
                    waitForTaskChange: execution.delegated.waitForTaskChange,
                    transitionTask: execution.delegated.transitionTask,
                }).finally(() => void drainQueuedAsyncTasks(input));
                continue;
            }
            void input.executeCommand(claimed, execution.command, execution.input, execution.controller, execution.launchControl);
        }
    });
}
