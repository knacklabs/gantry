import type { MessageSendOptions, NewMessage, ThinkingOverride } from '../domain/types.js';
import type { AsyncTaskRecord } from '../domain/ports/async-tasks.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import { type AgentResult } from './session-command-parse.js';
export { extractSessionCommand, isSessionCommandAllowed, } from './session-command-parse.js';
export type { AgentResult, SessionCommand } from './session-command-parse.js';
import { type ModelDefaultAliases } from '../shared/model-catalog.js';
import { type FamilyOrderOverrides } from '../shared/model-families.js';
import type { RuntimeModelStatusSnapshot } from '../runtime/model-status-store.js';
import { type BrowserStatusSnapshot, type CompactionStatusSnapshot, type MemoryStatusSnapshot } from './session-command-format.js';
import { type ModelStatusSelectionUpdate } from './session-model-status.js';
import { type PrepareSessionArchive } from './session-new-archive.js';
type CompactionProviderSession = {
    providerSessionId: string;
    externalSessionId: string;
};
export type SessionArchiveOutcome = {
    memory: 'ok' | 'degraded' | 'skipped';
};
export interface SessionCommandDeps {
    sendMessage: (text: string, options?: MessageSendOptions) => Promise<void>;
    setTyping: (typing: boolean) => Promise<void>;
    runAgent: (prompt: string, onOutput: (result: AgentResult) => Promise<void>, options?: {
        timeoutMs?: number;
        maintenanceProviderSession?: CompactionProviderSession;
    }) => Promise<'success' | 'error' | 'stopped'>;
    runSessionCompaction: (onOutput: (result: AgentResult) => Promise<void>, options: {
        maintenanceProviderSession: CompactionProviderSession;
    }) => Promise<'success' | 'error' | 'stopped'>;
    getSessionCompactionStrategy?: () => Promise<'provider_compaction' | 'fresh_checkpoint'>;
    closeStdin: () => void;
    advanceCursor: (message: Pick<NewMessage, 'timestamp' | 'id'>) => void;
    formatMessages: (msgs: NewMessage[], timezone: string) => string;
    getDefaultModel: () => string | undefined;
    getJobModelDefaults?: () => ModelDefaultAliases;
    getConfiguredModelProviders?: () => Promise<Set<string>>;
    getModelFamilyOrder?: () => FamilyOrderOverrides | undefined;
    getGroupModelOverride: () => string | undefined;
    setGroupModelOverride: (value: string | undefined) => Promise<void> | void;
    getModelStatus?: () => RuntimeModelStatusSnapshot | undefined;
    getBrowserStatus?: () => Promise<BrowserStatusSnapshot> | BrowserStatusSnapshot;
    updateModelStatusSelection?: (input: ModelStatusSelectionUpdate) => void;
    getGroupThinkingOverride: () => ThinkingOverride | undefined;
    setGroupThinkingOverride: (value: ThinkingOverride | undefined) => Promise<void> | void;
    getGroupPermissionModeOverride: () => PermissionMode | undefined;
    getDefaultPermissionMode: () => PermissionMode;
    setGroupPermissionModeOverride: (value: PermissionMode | undefined) => Promise<void> | void;
    archiveCurrentSession: (cause?: 'new-session' | 'manual-compact') => Promise<void | SessionArchiveOutcome>;
    prepareSessionArchive?: PrepareSessionArchive;
    onSessionArchived?: (cause?: 'new-session' | 'manual-compact') => Promise<void>;
    beginSessionCompaction?: (input?: {
        baseCursor?: string;
    }) => Promise<CompactionProviderSession | undefined>;
    admitSessionCompactionTask?: () => Promise<{
        task: AsyncTaskRecord;
        admitted: boolean;
    } | undefined>;
    markSessionCompactionTaskRunning?: (task: AsyncTaskRecord, locked: CompactionProviderSession) => Promise<AsyncTaskRecord | null>;
    heartbeatSessionCompactionTask?: (task: AsyncTaskRecord | undefined) => Promise<AsyncTaskRecord | null>;
    finishSessionCompactionTask?: (task: AsyncTaskRecord | undefined, outcome: 'ready' | 'degraded' | 'failed') => Promise<void>;
    finishSessionCompaction?: (locked: CompactionProviderSession | undefined, status: 'active' | 'expired' | 'ready') => Promise<void>;
    publishSessionCompactionEvent?: (state: 'queued' | 'running' | 'ready' | 'degraded' | 'failed' | 'timeout', details?: {
        task?: AsyncTaskRecord;
        strategy?: 'provider_compaction' | 'fresh_checkpoint';
        errorSummary?: string;
    }) => Promise<void> | void;
    clearCurrentSession: () => Promise<void> | void;
    stopCurrentRun?: () => boolean;
    runMemoryDreaming?: () => Promise<unknown>;
    getMemoryStatus?: () => Promise<MemoryStatusSnapshot>;
    getSessionCompactionStatus?: () => Promise<CompactionStatusSnapshot> | CompactionStatusSnapshot;
    saveProcedure?: (input: {
        title: string;
        body: string;
    }) => Promise<{
        id: string;
    } | void> | {
        id: string;
    } | void;
    /** Whether sender is explicitly trusted for control-plane commands. */
    isSenderControlAllowlisted: (msg: NewMessage) => boolean;
    /** Whether the denied sender would normally be allowed to interact (for denial messages). */
    canSenderInteract: (msg: NewMessage) => boolean;
    compactionScopeKey?: string;
}
/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export declare function handleSessionCommand(opts: {
    missedMessages: NewMessage[];
    groupName: string;
    triggerPattern: RegExp;
    timezone: string;
    deps: SessionCommandDeps;
}): Promise<{
    handled: false;
} | {
    handled: true;
    success: boolean;
}>;
