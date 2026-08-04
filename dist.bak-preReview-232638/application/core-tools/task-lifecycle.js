import { boundDelegatedTaskContextResult } from '../../shared/delegated-task-result-policy.js';
export function createCoreTaskLifecycleBackend(input) {
    const scoped = {
        ...input.owner,
        parentTaskId: input.parentTaskId ?? undefined,
    };
    return {
        owner: input.owner,
        task_get: async (args) => {
            const taskId = requiredString(args.taskId);
            if (!taskId)
                return invalid('task_get requires taskId.');
            const task = await input.service.getScoped({ ...scoped, taskId });
            return task
                ? { ok: true, message: 'Task loaded.', data: task }
                : { ok: false, message: 'Task not found.', code: 'not_found' };
        },
        task_list: async () => {
            const tasks = await input.service.list({ ...scoped, limit: 20 });
            return {
                ok: true,
                message: `Listed ${tasks.length} async task(s).`,
                data: { tasks },
            };
        },
        task_cancel: async (args) => {
            const taskId = requiredString(args.taskId);
            if (!taskId)
                return invalid('task_cancel requires taskId.');
            const result = await input.service.cancel({ ...scoped, taskId });
            return result.ok
                ? { ok: true, message: result.message, data: { taskId } }
                : {
                    ok: false,
                    message: result.message,
                    code: result.message.includes('already finished')
                        ? 'invalid_request'
                        : 'not_found',
                };
        },
        delegate_task: async (args) => {
            const objective = requiredString(args.objective);
            if (!objective)
                return invalid('delegate_task requires an objective.');
            if (!input.runDelegatedAgent) {
                return unavailable('Delegated agent runtime is unavailable.');
            }
            const targetAgentId = optionalString(args.targetAgentId);
            const result = await input.service.startDelegatedAgent({
                ...input.owner,
                parentRunId: input.parentRunId ?? null,
                objective,
                context: optionalString(args.context),
                expectedOutput: optionalString(args.expectedOutput),
                ...(targetAgentId ? { targetAgentId } : {}),
                authorityToolName: input.authorityToolName,
                workspaceFolder: input.workspaceFolder,
                run: (runInput) => input.runDelegatedAgent({
                    ...runInput,
                    ...(typeof args.timeoutMs === 'number'
                        ? { timeoutMs: args.timeoutMs }
                        : {}),
                }),
            });
            if (result.ok && typeof args.syncWaitTimeoutMs === 'number') {
                const completion = await result.completion.wait(args.syncWaitTimeoutMs);
                if (completion) {
                    return delegatedCompletionResult(completion);
                }
                if (input.enableDelegatedAsyncFollowUp) {
                    if (!input.service.markDelegatedTaskAsyncFallback) {
                        return unavailable('Delegated task follow-up persistence is unavailable.');
                    }
                    const terminal = await input.service.markDelegatedTaskAsyncFallback({
                        ...input.owner,
                        taskId: result.task.id,
                    });
                    if (terminal)
                        return delegatedCompletionResult(terminal);
                }
                return {
                    ok: true,
                    message: `Queued: ${result.task.id}`,
                    data: result.task,
                };
            }
            return result.ok
                ? {
                    ok: true,
                    message: `Queued: ${result.task.summary || result.task.id}`,
                    data: result.task,
                }
                : { ok: false, message: result.message, code: 'forbidden' };
        },
        task_message: async (args) => {
            const taskId = requiredString(args.taskId);
            const message = requiredString(args.message);
            if (!taskId || !message) {
                return invalid('task_message requires taskId and message.');
            }
            if (!input.deliverTaskMessage) {
                return unavailable('Task steering runtime is unavailable.');
            }
            const result = await input.service.message({
                ...scoped,
                taskId,
                message,
                deliver: input.deliverTaskMessage,
            });
            return result.ok
                ? { ok: true, message: result.message, data: { taskId } }
                : { ok: false, message: result.message, code: 'invalid_request' };
        },
    };
}
function delegatedCompletionResult(completion) {
    const message = boundDelegatedTaskContextResult(completion.status === 'completed'
        ? completion.result
        : completion.error || completion.result, completion.taskId);
    return completion.status === 'completed'
        ? {
            ok: true,
            message,
            data: { taskId: completion.taskId, status: completion.status },
        }
        : {
            ok: false,
            message,
            code: completion.status === 'cancelled'
                ? 'cancelled'
                : completion.status === 'failed'
                    ? 'failed'
                    : 'unavailable',
            data: { taskId: completion.taskId, status: completion.status },
        };
}
export function coreTaskLifecycleResultText(result) {
    if (result.data === undefined)
        return result.message;
    return `${result.message}\n${JSON.stringify(result.data, null, 2)}`;
}
function requiredString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function optionalString(value) {
    return requiredString(value) ?? undefined;
}
function invalid(message) {
    return { ok: false, message, code: 'invalid_request' };
}
function unavailable(message) {
    return { ok: false, message, code: 'unavailable' };
}
