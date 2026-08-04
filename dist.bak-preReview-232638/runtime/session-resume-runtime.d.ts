import type { NewMessage, ConversationRoute } from '../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type { CapabilitySecretRepository, McpServerRepository, SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import type { RunAgentOptions } from './agent-spawn-types.js';
import type { MemoryBoundaryDefaultScope, SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
export declare const RUNTIME_RESULT_SUMMARY_MAX_CHARS = 4000;
type RuntimeSessionArchiveOutcome = {
    memory: 'ok' | 'degraded' | 'skipped';
};
export declare function truncateRuntimeResultSummary(value: string, maxChars: number): string;
export declare function summarizeRuntimeResultForPersistence(value: string | null | undefined): string | null;
export declare function createRuntimeResultSummaryAccumulator(input?: {
    maxChars?: number;
}): {
    append: (delta: string) => void;
    snapshot: () => string | null;
};
export declare function createRuntimeUserVisibleResultAccumulator(input?: {
    maxChars?: number;
}): {
    append: (delta: string) => void;
    snapshot: () => string | null;
};
export declare function createRuntimeUserVisibleStreamSanitizer(): {
    append: (delta: string) => string;
    finish: () => string;
};
export declare function archiveCurrentRuntimeSession(input: {
    ops: RuntimeAgentSessionRepository;
    appId?: string;
    group: ConversationRoute;
    chatJid: string;
    threadId: string | null;
    cause?: 'new-session' | 'manual-compact';
    defaultScope?: MemoryBoundaryDefaultScope;
    memoryUserId?: string;
    collectMemory?: SessionMemoryCollector;
    executionProviderId?: import('../domain/sessions/sessions.js').ExecutionProviderId;
}): Promise<RuntimeSessionArchiveOutcome>;
export declare function buildRuntimeRunOptions(input: {
    timeoutMs?: number;
    signal?: AbortSignal;
    credentialBroker?: RunAgentOptions['credentialBroker'];
    skillRepository?: SkillCatalogRepository;
    skillArtifactStore?: SkillArtifactStore;
    mcpServerRepository?: McpServerRepository;
    capabilitySecretRepository?: CapabilitySecretRepository;
    mcpHostnameLookup?: HostnameLookup;
    mcpDnsValidationCache?: RemoteMcpDnsValidationCache;
    publishRuntimeEvent?: RunAgentOptions['publishRuntimeEvent'];
    executionAdapter?: RunAgentOptions['executionAdapter'];
    executionAdapters?: RunAgentOptions['executionAdapters'];
    runnerSandboxProvider: RunAgentOptions['runnerSandboxProvider'];
    asyncTaskRepositoryAvailable?: boolean;
    conversationRoutes?: Record<string, ConversationRoute>;
    skillContext?: {
        appId: string;
        agentId: string;
    };
    turnContext?: {
        appId: string;
        agentId: string;
        agentSessionId: string;
        externalSessionId?: string;
    };
}): RunAgentOptions;
export declare function completeSuccessfulRuntimeSessionRun(input: {
    ops: RuntimeAgentSessionRepository;
    group: ConversationRoute;
    chatJid?: string;
    threadId?: string | null;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    jobId?: string;
    agentSessionId?: string;
    agentSessionResetAt?: string | null;
    providerSessionId?: string;
    runId?: string;
    result?: string | null;
}): Promise<void>;
export declare function completeFailedRuntimeSessionRun(input: {
    ops: RuntimeAgentSessionRepository;
    runId?: string;
    errorSummary: string;
}): Promise<void>;
export declare function failRuntimeSessionRun(ops: RuntimeAgentSessionRepository, runId: string | undefined, errorSummary: string | null): Promise<void>;
export declare function buildApprovedSkillContextBlock(input: {
    skillRepository?: SkillCatalogRepository;
    skillArtifactStore?: SkillArtifactStore;
    turnContext?: {
        appId: string;
        agentId: string;
    };
}): Promise<string>;
export declare function resolveMemoryUserId(messages: NewMessage[]): string | undefined;
export declare function resolveNonSelfSenderIds(messages: readonly {
    sender?: string | null;
    is_from_me?: boolean | null;
}[]): string[];
export declare function resolveSingleNonSelfSenderId(messages: readonly {
    sender?: string | null;
    is_from_me?: boolean | null;
}[]): string | undefined;
export {};
