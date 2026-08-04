import type { AsyncTaskRecord, AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { NewMessage } from '../domain/types.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import { archiveCurrentRuntimeSession } from './session-resume-runtime.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
type ArchiveSessionInput = Parameters<typeof archiveCurrentRuntimeSession>[0];
type SenderPolicyGroup = {
    folder: string;
    requiresTrigger?: boolean;
};
export declare const SESSION_COMPACTION_TIMEOUT_MS: number;
export declare function createAdvanceCursorHandler(input: {
    queueJid: string;
    setCursor: (chatJid: string, timestamp: string) => void;
    saveState: () => Promise<void> | void;
    warn: (err: unknown) => void;
}): (message: Pick<NewMessage, "timestamp" | "id">) => void;
export declare function createArchiveCurrentSessionHandler(input: {
    ops: () => RuntimeAgentSessionRepository;
    appId?: string;
    group: ArchiveSessionInput['group'];
    chatJid: string;
    threadId: string | null;
    defaultScope: 'user' | 'group';
    memoryUserId?: string;
    collectMemory?: SessionMemoryCollector;
    executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
    resolveExecutionProviderId?: () => ExecutionProviderId | Promise<ExecutionProviderId>;
}): (cause?: ArchiveSessionInput["cause"]) => Promise<{
    memory: "ok" | "degraded" | "skipped";
}>;
export declare function createPrepareSessionArchiveHandler(input: {
    ops: () => RuntimeAgentSessionRepository;
    appId?: string;
    group: ArchiveSessionInput['group'];
    chatJid: string;
    threadId: string | null;
    defaultScope: 'user' | 'group';
    memoryUserId?: string;
    collectMemory?: SessionMemoryCollector;
    executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
    resolveExecutionProviderId?: () => ExecutionProviderId | Promise<ExecutionProviderId>;
}): (_cause: "new-session") => Promise<(() => Promise<void>) | undefined>;
export declare function createSessionArchiveHandlers(input: Parameters<typeof createArchiveCurrentSessionHandler>[0]): {
    archiveCurrentSession: (cause?: ArchiveSessionInput["cause"]) => Promise<{
        memory: "ok" | "degraded" | "skipped";
    }>;
    prepareSessionArchive: (_cause: "new-session") => Promise<(() => Promise<void>) | undefined>;
};
export declare function createSessionCompactionHandlers(input: Parameters<typeof createArchiveCurrentSessionHandler>[0] & {
    getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
    executionAdapters?: AgentExecutionAdapterRegistry;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
}): {
    admitSessionCompactionTask: () => Promise<{
        task: AsyncTaskRecord;
        admitted: boolean;
    } | undefined>;
    getSessionCompactionStrategy: () => Promise<"provider_compaction" | "fresh_checkpoint">;
    beginSessionCompaction: (input?: {
        baseCursor?: string;
    }) => Promise<{
        providerSessionId: string;
        externalSessionId: string;
    } | undefined>;
    markSessionCompactionTaskRunning: (task: AsyncTaskRecord, locked: {
        providerSessionId: string;
        externalSessionId: string;
    }) => Promise<AsyncTaskRecord | null>;
    heartbeatSessionCompactionTask: (task: AsyncTaskRecord | undefined) => Promise<AsyncTaskRecord | null>;
    finishSessionCompactionTask: (task: AsyncTaskRecord | undefined, outcome: "ready" | "degraded" | "failed") => Promise<void>;
    publishSessionCompactionEvent: (state: "queued" | "running" | "ready" | "degraded" | "failed" | "timeout", details?: {
        task?: AsyncTaskRecord;
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
};
export declare function releaseCompactionLockFromTask(ops: RuntimeAgentSessionRepository, fallbackProvider: string, task: AsyncTaskRecord): Promise<void>;
export declare function createSaveProcedureHandler(input: {
    folder: string;
    conversationId: string;
    userId?: string;
    defaultScope: 'user' | 'group';
    threadId?: string | null;
    isAdminWrite: boolean;
}): ({ title, body }: {
    title: string;
    body: string;
}) => Promise<import("../memory/memory-types.js").AppMemoryItem>;
export declare function createSenderCommandPolicy(input: {
    chatJid: string;
    group: SenderPolicyGroup;
    triggerPattern: RegExp;
}): {
    isSenderControlAllowlisted: (msg: NewMessage) => boolean;
    canSenderInteract: (msg: NewMessage) => boolean;
};
export {};
