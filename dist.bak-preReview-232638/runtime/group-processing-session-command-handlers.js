import { logger } from '../infrastructure/logging/logger.js';
import { formatMessages } from '../messaging/router.js';
import { getGroupBrowserStatus } from './group-browser-status.js';
import { getGroupMemoryStatus } from './group-memory-commands.js';
import { createAdvanceCursorHandler, createSaveProcedureHandler, createSenderCommandPolicy, createSessionArchiveHandlers, createSessionCompactionHandlers, } from './group-session-command-state.js';
import { resolveGroupRouteExecutionProviderIdForDeps } from './group-initial-execution-provider.js';
import { createRuntimeModelStatusAccess } from './model-status-store.js';
import { runDreamingForGroup } from './memory-dreaming-runner.js';
import { createSessionCommandAgentRunners } from './group-session-command-runner.js';
export function createGroupProcessingSessionCommandHandlers(input) {
    const { deps, group, appId } = input;
    const modelStatus = createRuntimeModelStatusAccess(group.folder, input.threadId);
    const senderCommandPolicy = createSenderCommandPolicy({
        chatJid: input.chatJid,
        group,
        triggerPattern: input.triggerPattern,
    });
    const stateInput = {
        ops: input.ops,
        appId,
        group,
        chatJid: input.chatJid,
        threadId: input.threadId ?? null,
        defaultScope: input.defaultScope,
        memoryUserId: input.memoryUserId,
        collectMemory: input.collectMemory,
        executionAdapter: deps.executionAdapter,
        executionAdapters: deps.executionAdapters,
        resolveExecutionProviderId: () => resolveGroupRouteExecutionProviderIdForDeps({
            group,
            appId,
            defaultModel: input.defaultModel,
            deps,
        }),
        getAsyncTaskRepository: deps.getAsyncTaskRepository,
        publishRuntimeEvent: deps.publishRuntimeEvent,
    };
    return {
        sendMessage: (text, options) => input.sendMessage(text, input.buildMessageOptions(options?.threadId)),
        setTyping: input.setTyping,
        ...createSessionCommandAgentRunners({
            runAgent: input.runAgent,
            group,
            chatJid: input.chatJid,
            queueJid: input.queueJid,
            memoryUserId: input.memoryUserId,
            activeThreadId: input.threadId,
            missedMessages: input.missedMessages,
            existingRunId: input.processOptions.existingRunId,
            existingRunLeaseToken: input.processOptions.existingRunLeaseToken,
            existingRunLeaseWorkerInstanceId: input.processOptions.existingRunLeaseWorkerInstanceId,
            existingRunLeaseFencingVersion: input.processOptions.existingRunLeaseFencingVersion,
        }),
        closeStdin: () => deps.queue.closeStdin(input.queueJid),
        compactionScopeKey: input.queueJid,
        advanceCursor: createAdvanceCursorHandler({
            queueJid: input.queueJid,
            setCursor: deps.setCursor,
            saveState: deps.saveState,
            warn: (err) => logger.warn({ group: group.name, err }, 'Failed to persist session command cursor'),
        }),
        formatMessages,
        getDefaultModel: input.getDefaultModel,
        getJobModelDefaults: input.getJobModelDefaults,
        getConfiguredModelProviders: input.getConfiguredModelProviders,
        getModelFamilyOrder: input.getModelFamilyOrder,
        getGroupModelOverride: () => group.agentConfig?.model,
        setGroupModelOverride: async (value) => deps.setGroupModelOverride(input.commandOverrideRouteKey, value),
        getModelStatus: modelStatus.getStatus,
        getBrowserStatus: () => getGroupBrowserStatus({ group, chatJid: input.chatJid }),
        updateModelStatusSelection: modelStatus.updateSelection,
        getGroupThinkingOverride: () => group.agentConfig?.thinking,
        setGroupThinkingOverride: (value) => deps.setGroupThinkingOverride(input.commandOverrideRouteKey, value),
        getGroupPermissionModeOverride: () => group.agentConfig?.permissionMode,
        getDefaultPermissionMode: input.getDefaultPermissionMode,
        setGroupPermissionModeOverride: (value) => deps.setGroupPermissionModeOverride(input.commandOverrideRouteKey, value),
        ...createSessionArchiveHandlers(stateInput),
        ...createSessionCompactionHandlers(stateInput),
        clearCurrentSession: () => deps.clearSession(group.folder, input.threadId, {
            appId,
            conversationJid: input.chatJid,
            providerAccountId: group.providerAccountId,
            conversationKind: group.conversationKind,
            memoryUserId: input.memoryUserId,
        }),
        stopCurrentRun: () => deps.queue.stopGroup?.(input.queueJid) ?? false,
        runMemoryDreaming: () => runDreamingForGroup({
            folder: group.folder,
            conversationId: input.chatJid,
            userId: input.memoryUserId,
            activeThreadId: input.threadId ?? undefined,
            defaultScope: input.defaultScope,
        }),
        getMemoryStatus: async () => {
            const memory = input.getMemorySettings();
            return getGroupMemoryStatus({
                folder: group.folder,
                conversationId: input.chatJid,
                userId: input.memoryUserId,
                threadId: input.threadId,
                defaultScope: input.defaultScope,
            }, {
                memoryEnabled: memory.enabled,
                embeddings: memory.enabled &&
                    memory.embeddings.enabled &&
                    memory.embeddings.provider !== 'disabled'
                    ? 'configured'
                    : 'disabled',
            });
        },
        saveProcedure: createSaveProcedureHandler({
            folder: group.folder,
            conversationId: input.chatJid,
            userId: input.memoryUserId,
            defaultScope: input.defaultScope,
            threadId: input.threadId,
            isAdminWrite: true,
        }),
        ...senderCommandPolicy,
    };
}
