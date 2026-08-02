import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import { ConversationRoute, ThinkingOverride } from '../../domain/types.js';
import type { GroupProcessingDeps } from '../../runtime/group-processing-types.js';
import { GroupQueue } from '../../runtime/group-queue.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type { RuntimeAgentSessionRepository, RuntimeChatMetadataRepository, RuntimeConversationRouteRepository, RuntimeMessageRepository, RuntimeRouterStateRepository } from '../../domain/repositories/ops-repo.js';
import type { ProcessRole } from './roles/process-role.js';
import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../../application/agent-execution/agent-execution-adapter-registry.js';
import type { RunnerSandboxProvider } from '../../shared/runner-sandbox-provider.js';
export type RuntimeAppRepository = RuntimeRouterStateRepository & RuntimeMessageRepository & RuntimeConversationRouteRepository & RuntimeChatMetadataRepository & RuntimeAgentSessionRepository;
export interface RuntimeApp {
    executionAdapter: AgentExecutionAdapter;
    executionAdapters: AgentExecutionAdapterRegistry;
    runnerSandboxProvider: RunnerSandboxProvider;
    queue: GroupQueue;
    loadState: () => Promise<void>;
    saveState: () => Promise<void>;
    getOrRecoverCursor: (chatJid: string) => Promise<string>;
    registerGroup: (jid: string, group: ConversationRoute) => Promise<void>;
    projectConversationRoute: (jid: string, group: ConversationRoute) => Promise<void>;
    unregisterConversationRoute: (jid: string) => Promise<void>;
    setGroupModelOverride: (chatJid: string, model: string | undefined) => Promise<void>;
    setGroupThinkingOverride: (chatJid: string, thinking: ThinkingOverride | undefined) => Promise<void>;
    setGroupPermissionModeOverride: GroupProcessingDeps['setGroupPermissionModeOverride'];
    getAvailableGroups: () => Promise<import('../../runtime/agent-spawn.js').AvailableGroup[]>;
    setConversationRoutesForTest: (groups: Record<string, ConversationRoute>) => void;
    ensureCredentialBindingsForConversationRoutes: () => Promise<void>;
    getCredentialBroker: () => Promise<AgentCredentialBroker | undefined>;
    clearSessionForChatJid: (chatJid: string, threadId?: string | null, metadata?: {
        memoryUserId?: string;
        providerAccountId?: string | null;
    }) => Promise<void>;
    processGroupMessages: (chatJid: string, options?: {
        queued?: boolean;
        existingRunId?: string;
        existingRunLeaseToken?: string;
        existingRunLeaseWorkerInstanceId?: string;
        existingRunLeaseFencingVersion?: number;
        onRunResult?: (result: 'success' | 'error' | 'stopped') => void;
        onFirstProgress?: (input: {
            jid: string;
            messageRef: string;
        }) => Promise<void> | void;
    }) => Promise<boolean>;
    getConversationRoutes: () => Record<string, ConversationRoute>;
    resolveExecutionProviderId: (route: Pick<ConversationRoute, 'agentConfig' | 'folder'>, chatJid: string) => Promise<ExecutionProviderId>;
    setAgentCursor: (chatJid: string, timestamp: string) => void;
    setChannelRuntime: (runtime: GroupProcessingDeps['channelRuntime']) => void;
}
export interface RuntimeAppOptions {
    ensureCredentialBinding?: (input: {
        groupJid: string;
        group: ConversationRoute;
        agentIdentifier: string;
        agentName: string;
    }) => Promise<{
        created?: boolean;
    } | undefined>;
    queue?: GroupQueue;
    runAgent?: GroupProcessingDeps['runAgent'];
    skillArtifactStore?: GroupProcessingDeps['getSkillArtifactStore'];
    mcpHostnameLookup?: GroupProcessingDeps['getMcpHostnameLookup'];
    collectSessionMemory?: GroupProcessingDeps['collectSessionMemory'];
    publishRuntimeEvent?: GroupProcessingDeps['publishRuntimeEvent'];
    executionAdapter?: AgentExecutionAdapter;
    executionAdapters?: AgentExecutionAdapterRegistry;
    runnerSandboxProvider?: RunnerSandboxProvider;
    opsRepository?: RuntimeAppRepository;
    processRole?: ProcessRole;
}
export declare function createRuntimeApp(options?: RuntimeAppOptions): RuntimeApp;
export declare const collectRuntimeSessionMemory: import('../../domain/ports/session-memory-collector.js').SessionMemoryCollector;
export declare function getDefaultRuntimeApp(options?: RuntimeAppOptions): RuntimeApp;
export declare function getAvailableGroups(): Promise<import('../../runtime/agent-spawn.js').AvailableGroup[]>;
/** @internal - exported for testing */
export declare function _setConversationRoutes(groups: Record<string, ConversationRoute>): void;
