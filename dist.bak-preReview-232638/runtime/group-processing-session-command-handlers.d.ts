import type { ConversationRoute, MessageSendOptions, NewMessage } from '../domain/types.js';
import { formatMessages } from '../messaging/router.js';
import type { SessionCommandDeps } from '../session/session-commands.js';
import { createSessionCommandAgentRunners } from './group-session-command-runner.js';
import type { GroupProcessOptions, GroupProcessingDeps, GroupProcessingRepository } from './group-processing-types.js';
export declare function createGroupProcessingSessionCommandHandlers(input: {
    ops: () => GroupProcessingRepository;
    appId: string;
    defaultModel?: string;
    group: ConversationRoute;
    chatJid: string;
    threadId?: string | null;
    defaultScope: 'user' | 'group';
    memoryUserId?: string;
    collectMemory?: GroupProcessingDeps['collectSessionMemory'];
    deps: GroupProcessingDeps;
    queueJid: string;
    missedMessages: NewMessage[];
    runAgent: Parameters<typeof createSessionCommandAgentRunners>[0]['runAgent'];
    processOptions: GroupProcessOptions;
    commandOverrideRouteKey: string;
    setTyping: (isTyping: boolean) => Promise<void>;
    sendMessage: (text: string, options?: MessageSendOptions) => Promise<void>;
    buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
    triggerPattern: RegExp;
    getDefaultModel: SessionCommandDeps['getDefaultModel'];
    getJobModelDefaults: SessionCommandDeps['getJobModelDefaults'];
    getConfiguredModelProviders: SessionCommandDeps['getConfiguredModelProviders'];
    getModelFamilyOrder: SessionCommandDeps['getModelFamilyOrder'];
    getDefaultPermissionMode: SessionCommandDeps['getDefaultPermissionMode'];
    getMemorySettings: () => {
        enabled: boolean;
        embeddings: {
            enabled: boolean;
            provider: string;
        };
    };
}): {
    isSenderControlAllowlisted: (msg: NewMessage) => boolean;
    canSenderInteract: (msg: NewMessage) => boolean;
    clearCurrentSession: () => void | Promise<void>;
    stopCurrentRun: () => boolean;
    runMemoryDreaming: () => Promise<{
        queued: boolean;
        pending: number;
        deduped: boolean;
        reason: "full" | "queued" | "invalid" | "deduped";
    }>;
    getMemoryStatus: () => Promise<import("../session/session-command-format.js").MemoryStatusSnapshot>;
    saveProcedure: ({ title, body }: {
        title: string;
        body: string;
    }) => Promise<import("../memory/memory-types.js").AppMemoryItem>;
    admitSessionCompactionTask: () => Promise<{
        task: import("../domain/ports/async-tasks.js").AsyncTaskRecord;
        admitted: boolean;
    } | undefined>;
    getSessionCompactionStrategy: () => Promise<"provider_compaction" | "fresh_checkpoint">;
    beginSessionCompaction: (input?: {
        baseCursor?: string;
    }) => Promise<{
        providerSessionId: string;
        externalSessionId: string;
    } | undefined>;
    markSessionCompactionTaskRunning: (task: import("../domain/ports/async-tasks.js").AsyncTaskRecord, locked: {
        providerSessionId: string;
        externalSessionId: string;
    }) => Promise<import("../domain/ports/async-tasks.js").AsyncTaskRecord | null>;
    heartbeatSessionCompactionTask: (task: import("../domain/ports/async-tasks.js").AsyncTaskRecord | undefined) => Promise<import("../domain/ports/async-tasks.js").AsyncTaskRecord | null>;
    finishSessionCompactionTask: (task: import("../domain/ports/async-tasks.js").AsyncTaskRecord | undefined, outcome: "ready" | "degraded" | "failed") => Promise<void>;
    publishSessionCompactionEvent: (state: "queued" | "running" | "ready" | "degraded" | "failed" | "timeout", details?: {
        task?: import("../domain/ports/async-tasks.js").AsyncTaskRecord;
        strategy?: "provider_compaction" | "fresh_checkpoint";
        errorSummary?: string;
    }) => Promise<void>;
    getSessionCompactionStatus: () => Promise<{
        state: "timeout" | "failed" | "queued" | "running" | "ready" | "degraded";
    } | {
        state: "idle";
    }>;
    finishSessionCompaction: (locked: {
        providerSessionId: string;
        externalSessionId: string;
    } | undefined, status: "active" | "expired" | "ready") => Promise<void>;
    archiveCurrentSession: (cause?: "new-session" | "manual-compact" | undefined) => Promise<{
        memory: "ok" | "degraded" | "skipped";
    }>;
    prepareSessionArchive: (_cause: "new-session") => Promise<(() => Promise<void>) | undefined>;
    closeStdin: () => void;
    compactionScopeKey: string;
    advanceCursor: (message: Pick<NewMessage, "timestamp" | "id">) => void;
    formatMessages: typeof formatMessages;
    getDefaultModel: () => string | undefined;
    getJobModelDefaults: (() => import("../shared/model-catalog.js").ModelDefaultAliases) | undefined;
    getConfiguredModelProviders: (() => Promise<Set<string>>) | undefined;
    getModelFamilyOrder: (() => import("../shared/model-families.js").FamilyOrderOverrides | undefined) | undefined;
    getGroupModelOverride: () => string | undefined;
    setGroupModelOverride: (value: Parameters<GroupProcessingDeps["setGroupModelOverride"]>[1]) => Promise<void>;
    getModelStatus: () => import("./model-status-store.js").RuntimeModelStatusSnapshot | undefined;
    getBrowserStatus: () => Promise<import("../session/session-command-format.js").BrowserStatusSnapshot>;
    updateModelStatusSelection: (input: import("./model-status-store.js").RuntimeModelStatusSelectionUpdate) => void;
    getGroupThinkingOverride: () => import("../domain/types.js").ThinkingOverride | undefined;
    setGroupThinkingOverride: (value: Parameters<GroupProcessingDeps["setGroupThinkingOverride"]>[1]) => void | Promise<void>;
    getGroupPermissionModeOverride: () => import("../shared/permission-mode.js").PermissionMode | undefined;
    getDefaultPermissionMode: () => import("../shared/permission-mode.js").PermissionMode;
    setGroupPermissionModeOverride: (value: Parameters<GroupProcessingDeps["setGroupPermissionModeOverride"]>[1]) => void | Promise<void>;
    runAgent: (prompt: string, onOutput: (result: import("../session/session-command-parse.js").AgentResult) => Promise<void>, options?: {
        timeoutMs?: number;
        maintenanceProviderSession?: {
            providerSessionId: string;
            externalSessionId: string;
        };
    }) => Promise<"success" | "error" | "stopped">;
    runSessionCompaction: (onOutput: (result: import("../session/session-command-parse.js").AgentResult) => Promise<void>, options: {
        maintenanceProviderSession: {
            providerSessionId: string;
            externalSessionId: string;
        };
    }) => Promise<"success" | "error" | "stopped">;
    sendMessage: (text: string, options?: {
        threadId?: string;
    }) => Promise<void>;
    setTyping: (isTyping: boolean) => Promise<void>;
};
