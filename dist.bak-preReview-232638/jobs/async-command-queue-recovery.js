import { failedReceipt } from './async-command-task-receipts.js';
import { readEncryptedAsyncTaskPayload } from './async-task-execution-payload.js';
import { nowIso } from '../shared/time/datetime.js';
export async function recoverQueuedAsyncTasks(input) {
    let recovered = await recoverQueuedAsyncCommandTasks(input);
    if (input.createDelegatedRun) {
        recovered += await recoverQueuedDelegatedAgentTasks({
            ...input,
            createRun: input.createDelegatedRun,
        });
    }
    return recovered;
}
async function recoverQueuedAsyncCommandTasks(input) {
    const tasks = await input.repository.listTasks({
        appId: input.appId,
        agentId: input.agentId,
        kind: 'async_command',
        statuses: ['queued'],
        order: 'oldest_first',
        limit: input.limit ?? 100,
    });
    let recovered = 0;
    for (const task of tasks) {
        if (input.pending.has(task.id))
            continue;
        const payload = readEncryptedAsyncTaskPayload(task);
        if (!isDurableAsyncCommandPayload(payload)) {
            if (await failUnrecoverableQueuedTask(input.transitionTask, task)) {
                recovered += 1;
            }
            continue;
        }
        input.pending.set(task.id, {
            task,
            command: payload.command,
            input: payload.input,
            controller: new AbortController(),
            launchControl: payload.launchControl,
        });
        recovered += 1;
    }
    return recovered;
}
async function recoverQueuedDelegatedAgentTasks(input) {
    const tasks = await input.repository.listTasks({
        appId: input.appId,
        agentId: input.agentId,
        kind: 'delegated_agent',
        statuses: ['queued'],
        order: 'oldest_first',
        limit: input.limit ?? 100,
    });
    let recovered = 0;
    for (const task of tasks) {
        if (input.pending.has(task.id))
            continue;
        const payload = readEncryptedAsyncTaskPayload(task);
        if (!isDurableDelegatedAgentPayload(payload)) {
            if (await failUnrecoverableQueuedTask(input.transitionTask, task)) {
                recovered += 1;
            }
            continue;
        }
        const taskInput = {
            appId: task.appId,
            agentId: task.agentId,
            conversationId: task.conversationId ?? '',
            threadId: task.threadId,
            parentRunId: task.parentRunId,
            objective: payload.objective,
            context: payload.context,
            expectedOutput: payload.expectedOutput,
            providerAccountId: payload.providerAccountId,
            targetAgentId: payload.targetAgentId,
            workspaceFolder: payload.workspaceFolder,
        };
        input.pending.set(task.id, {
            task,
            command: '',
            input: undefined,
            controller: new AbortController(),
            launchControl: undefined,
            delegated: {
                taskInput: {
                    ...taskInput,
                    run: input.createRun(task, taskInput),
                },
                cancelLinkedChildTasks: input.cancelLinkedChildTasks,
                waitForTaskChange: input.waitForTaskChange,
                transitionTask: input.transitionTask,
            },
        });
        recovered += 1;
    }
    return recovered;
}
async function failUnrecoverableQueuedTask(transitionTask, task) {
    const now = nowIso();
    const updated = await transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: 'failed',
        now,
        terminalAt: now,
        errorSummary: 'Queued async task has no recoverable execution payload.',
        receiptJson: failedReceipt(task, 'failed before recovery because execution payload is missing or unreadable'),
    });
    return Boolean(updated);
}
function isDurableAsyncCommandPayload(value) {
    return Boolean(value &&
        typeof value.command === 'string' &&
        value.launchControl &&
        typeof value.launchControl === 'object');
}
function isDurableDelegatedAgentPayload(value) {
    return Boolean(value &&
        typeof value.objective === 'string' &&
        (value.providerAccountId === undefined ||
            value.providerAccountId === null ||
            typeof value.providerAccountId === 'string') &&
        (value.targetAgentId === undefined ||
            typeof value.targetAgentId === 'string') &&
        typeof value.workspaceFolder === 'string');
}
