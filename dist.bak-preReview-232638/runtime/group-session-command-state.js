import { randomUUID } from 'node:crypto';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { isSenderControlAllowed, isTriggerAllowed, loadSenderControlAllowlist, loadSenderAllowlist, } from '../platform/sender-allowlist.js';
import { encodeGroupMessageCursor, toGroupMessageCursor, } from '../shared/message-cursor.js';
import { archiveCurrentRuntimeSession } from './session-resume-runtime.js';
import { saveGroupProcedureMemory } from './group-memory-commands.js';
import { resolveRuntimeExecutionProviderId } from './execution-provider-id.js';
import { maintenanceCompactionPromptForExecutionProvider } from './group-agent-runner-maintenance-compaction.js';
export const SESSION_COMPACTION_TIMEOUT_MS = 10 * 60_000;
export function createAdvanceCursorHandler(input) {
    return (message) => {
        input.setCursor(input.queueJid, encodeGroupMessageCursor(toGroupMessageCursor(message)));
        void Promise.resolve(input.saveState()).catch(input.warn);
    };
}
export function createArchiveCurrentSessionHandler(input) {
    return async (cause = 'new-session') => {
        const executionProviderId = await resolveSessionCommandExecutionProviderId(input);
        return archiveCurrentRuntimeSession({
            ops: input.ops(),
            appId: input.appId,
            group: input.group,
            chatJid: input.chatJid,
            threadId: input.threadId,
            cause,
            defaultScope: input.defaultScope,
            memoryUserId: input.memoryUserId,
            executionProviderId: resolveRuntimeExecutionProviderId({
                id: executionProviderId,
            }),
            ...(input.collectMemory ? { collectMemory: input.collectMemory } : {}),
        });
    };
}
export function createPrepareSessionArchiveHandler(input) {
    return async (_cause) => {
        const ops = input.ops();
        const executionProviderId = await resolveSessionCommandExecutionProviderId(input);
        const turnContext = await ops.getAgentTurnContext?.({
            appId: input.appId,
            agentFolder: input.group.folder,
            executionProviderId,
            conversationJid: input.chatJid,
            providerAccountId: input.group.providerAccountId,
            threadId: input.threadId,
            conversationKind: input.group.conversationKind,
            memoryUserId: input.memoryUserId,
            hydrateMemory: false,
        });
        if (!turnContext?.agentSessionId || !input.collectMemory) {
            return undefined;
        }
        const agentSessionId = turnContext.agentSessionId;
        return async () => {
            await input.collectMemory?.({
                agentSessionId,
                trigger: 'session-end',
                defaultScope: input.defaultScope,
            });
        };
    };
}
export function createSessionArchiveHandlers(input) {
    return {
        archiveCurrentSession: createArchiveCurrentSessionHandler(input),
        prepareSessionArchive: createPrepareSessionArchiveHandler(input),
    };
}
export function createSessionCompactionHandlers(input) {
    const getContext = async () => {
        const ops = input.ops();
        const executionProviderId = await resolveSessionCommandExecutionProviderId(input);
        const context = await ops.getAgentTurnContext?.({
            appId: input.appId,
            agentFolder: input.group.folder,
            executionProviderId,
            conversationJid: input.chatJid,
            providerAccountId: input.group.providerAccountId,
            threadId: input.threadId,
            conversationKind: input.group.conversationKind,
            memoryUserId: input.memoryUserId,
            hydrateMemory: false,
        });
        const repository = input.getAsyncTaskRepository?.();
        return { ops, executionProviderId, context, repository };
    };
    const releaseStaleTaskLocks = async (tasks) => {
        if (tasks.length === 0)
            return;
        const { ops, executionProviderId } = await getContext();
        if (!ops.finishProviderSessionMaintenance)
            return;
        await Promise.all(tasks.map((task) => releaseCompactionLockFromTask(ops, executionProviderId, task)));
    };
    return {
        admitSessionCompactionTask: async () => {
            const { context, repository } = await getContext();
            if (!repository?.createTaskWithScopedAdmission || !context?.agentId) {
                return undefined;
            }
            const now = new Date().toISOString();
            const staleBefore = new Date(Date.now() - SESSION_COMPACTION_TIMEOUT_MS).toISOString();
            const result = await repository.createTaskWithScopedAdmission({
                task: {
                    id: `task_${randomUUID()}`,
                    appId: input.appId ?? context.appId,
                    agentId: context.agentId,
                    conversationId: input.chatJid,
                    threadId: input.threadId,
                    kind: 'session_compaction',
                    status: 'queued',
                    admissionClass: 'task',
                    authoritySnapshotJson: {
                        internal: true,
                        command: '/compact',
                    },
                    privateCorrelationJson: {
                        agentSessionId: context.agentSessionId,
                        scopeKey: `${input.chatJid}:${input.threadId ?? ''}`,
                    },
                    leaseToken: randomUUID(),
                    fencingVersion: 1,
                    summary: 'Session compaction',
                    now,
                },
                activeStatuses: ['queued', 'running'],
                staleRunningBefore: staleBefore,
                staleRunningStatus: 'timed_out',
                staleErrorSummary: 'Session compaction exceeded the 10 minute timeout.',
            });
            await releaseStaleTaskLocks(result.staleTasks);
            return { task: result.task, admitted: result.admitted };
        },
        getSessionCompactionStrategy: async () => {
            const { executionProviderId } = await getContext();
            const prompt = maintenanceCompactionPromptForExecutionProvider(executionProviderId, {
                executionAdapter: input.executionAdapter,
                executionAdapters: input.executionAdapters,
            });
            return prompt ? 'provider_compaction' : 'fresh_checkpoint';
        },
        beginSessionCompaction: async (input) => {
            const { ops, executionProviderId, context } = await getContext();
            if (!context?.providerSessionId ||
                !context.externalSessionId ||
                !ops.markProviderSessionMaintenance)
                return undefined;
            const locked = await ops.markProviderSessionMaintenance({
                providerSessionId: context.providerSessionId,
                agentSessionId: context.agentSessionId,
                provider: executionProviderId,
                externalSessionId: context.externalSessionId,
                compactionBaseCursor: input?.baseCursor ?? null,
            });
            return locked
                ? {
                    providerSessionId: context.providerSessionId,
                    externalSessionId: context.externalSessionId,
                }
                : undefined;
        },
        markSessionCompactionTaskRunning: async (task, locked) => {
            const { repository, executionProviderId, context } = await getContext();
            if (!repository)
                return null;
            return repository.transitionTask({
                taskId: task.id,
                leaseToken: task.leaseToken,
                fencingVersion: task.fencingVersion,
                status: 'running',
                now: new Date().toISOString(),
                heartbeatAt: new Date().toISOString(),
                startedAt: new Date().toISOString(),
                privateCorrelationJson: {
                    ...task.privateCorrelationJson,
                    provider: executionProviderId,
                    agentSessionId: context?.agentSessionId,
                    providerSessionId: locked.providerSessionId,
                    externalSessionId: locked.externalSessionId,
                },
            });
        },
        heartbeatSessionCompactionTask: async (task) => {
            if (!task)
                return null;
            const { repository } = await getContext();
            if (!repository)
                return null;
            const now = new Date().toISOString();
            return repository.transitionTask({
                taskId: task.id,
                leaseToken: task.leaseToken,
                fencingVersion: task.fencingVersion,
                status: 'running',
                now,
                heartbeatAt: now,
            });
        },
        finishSessionCompactionTask: async (task, outcome) => {
            if (!task)
                return;
            const { repository } = await getContext();
            if (!repository)
                return;
            const now = new Date().toISOString();
            const terminal = outcome === 'failed'
                ? { errorSummary: 'Session compaction did not finish.' }
                : { outputSummary: outcome, errorSummary: null };
            await repository.transitionTask({
                taskId: task.id,
                leaseToken: task.leaseToken,
                fencingVersion: task.fencingVersion,
                status: outcome === 'failed' ? 'failed' : 'completed',
                now,
                terminalAt: now,
                ...terminal,
            });
        },
        publishSessionCompactionEvent: async (state, details) => {
            if (!input.publishRuntimeEvent)
                return;
            const { context, executionProviderId } = await getContext();
            if (!context?.appId)
                return;
            await input.publishRuntimeEvent({
                appId: context.appId,
                ...(context.agentId ? { agentId: context.agentId } : {}),
                ...(context.agentSessionId
                    ? { sessionId: context.agentSessionId }
                    : {}),
                conversationId: input.chatJid,
                ...(input.threadId ? { threadId: input.threadId } : {}),
                eventType: sessionCompactionEventType(state),
                actor: 'runtime',
                responseMode: 'none',
                payload: {
                    state,
                    provider: executionProviderId,
                    ...(details?.task ? { taskId: details.task.id } : {}),
                    ...(details?.strategy ? { strategy: details.strategy } : {}),
                    ...(details?.errorSummary
                        ? { errorSummary: details.errorSummary }
                        : {}),
                },
            });
        },
        getSessionCompactionStatus: async () => {
            const { context, repository } = await getContext();
            if (context?.latestProviderSessionLocked)
                return { state: 'running' };
            if (context?.latestProviderSessionReady)
                return { state: 'ready' };
            const taskStatus = repository
                ? await latestCompactionTaskStatus(repository, {
                    appId: input.appId ?? context?.appId,
                    agentId: context?.agentId,
                    conversationId: input.chatJid,
                    threadId: input.threadId,
                })
                : undefined;
            if (taskStatus)
                return { state: taskStatus };
            return { state: 'idle' };
        },
        finishSessionCompaction: async (locked, status) => {
            if (!locked)
                return;
            const { ops, executionProviderId, context } = await getContext();
            if (!ops.finishProviderSessionMaintenance)
                return;
            if (!context?.agentSessionId)
                return;
            await ops.finishProviderSessionMaintenance({
                providerSessionId: locked.providerSessionId,
                agentSessionId: context.agentSessionId,
                provider: executionProviderId,
                externalSessionId: locked.externalSessionId,
                status,
            });
        },
    };
}
async function resolveSessionCommandExecutionProviderId(input) {
    return ((await input.resolveExecutionProviderId?.()) ??
        resolveRuntimeExecutionProviderId(input.executionAdapter));
}
function sessionCompactionEventType(state) {
    switch (state) {
        case 'queued':
            return RUNTIME_EVENT_TYPES.SESSION_COMPACTION_QUEUED;
        case 'running':
            return RUNTIME_EVENT_TYPES.SESSION_COMPACTION_RUNNING;
        case 'ready':
            return RUNTIME_EVENT_TYPES.SESSION_COMPACTION_READY;
        case 'degraded':
            return RUNTIME_EVENT_TYPES.SESSION_COMPACTION_DEGRADED;
        case 'failed':
            return RUNTIME_EVENT_TYPES.SESSION_COMPACTION_FAILED;
        case 'timeout':
            return RUNTIME_EVENT_TYPES.SESSION_COMPACTION_TIMEOUT;
    }
}
async function latestCompactionTaskStatus(repository, scope) {
    if (!scope.appId || !scope.agentId)
        return undefined;
    const [task] = await repository.listTasks({
        appId: scope.appId,
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        threadId: scope.threadId,
        kind: 'session_compaction',
        limit: 1,
    });
    if (!task)
        return undefined;
    if (task.status === 'queued' || task.status === 'running') {
        return task.status;
    }
    if (task.status === 'timed_out')
        return 'timeout';
    if (task.status === 'failed' || task.status === 'cancelled')
        return 'failed';
    if (task.status === 'completed') {
        return task.outputSummary === 'degraded' ? 'degraded' : 'ready';
    }
    return undefined;
}
export async function releaseCompactionLockFromTask(ops, fallbackProvider, task) {
    const data = task.privateCorrelationJson;
    const providerSessionId = stringValue(data.providerSessionId);
    const agentSessionId = stringValue(data.agentSessionId);
    const externalSessionId = stringValue(data.externalSessionId);
    if (!providerSessionId || !agentSessionId || !externalSessionId)
        return;
    await ops.finishProviderSessionMaintenance?.({
        providerSessionId,
        agentSessionId,
        provider: stringValue(data.provider) ?? fallbackProvider,
        externalSessionId,
        status: 'expired',
    });
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
export function createSaveProcedureHandler(input) {
    return async ({ title, body }) => saveGroupProcedureMemory({
        folder: input.folder,
        conversationId: input.conversationId,
        userId: input.userId,
        defaultScope: input.defaultScope,
        threadId: input.threadId,
        isAdminWrite: input.isAdminWrite,
        title,
        body,
    });
}
export function createSenderCommandPolicy(input) {
    return {
        isSenderControlAllowlisted: (msg) => isSenderControlAllowed(input.chatJid, msg.sender, loadSenderControlAllowlist(), input.group.folder),
        canSenderInteract: (msg) => {
            const hasTrigger = input.triggerPattern.test(msg.content.trim());
            const reqTrigger = input.group.requiresTrigger !== false;
            return (!reqTrigger ||
                (hasTrigger &&
                    (msg.is_from_me ||
                        isTriggerAllowed(input.chatJid, msg.sender, loadSenderAllowlist(), input.group.folder))));
        },
    };
}
