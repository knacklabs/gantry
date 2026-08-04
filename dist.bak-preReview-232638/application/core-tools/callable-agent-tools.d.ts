import type { Agent } from '../../domain/agent/agent.js';
import type { AgentRepository } from '../../domain/ports/repositories.js';
import type { ConversationRoute } from '../../domain/types.js';
import { type CallableAgentToolInputSchema, type CallableAgentToolManifestEntry } from '../../shared/callable-agent-manifest.js';
import type { CoreTaskLifecycleBackend, CoreTaskLifecycleResult } from './task-lifecycle.js';
import { type CoreSendMessageDeps } from './send-message.js';
export { CALLABLE_AGENT_RESPONSE_TIMEOUT_MS, CALLABLE_AGENT_SYNC_WAIT_MAX_MS, CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS, CALLABLE_AGENT_TOOL_PREFIX, callableAgentToolName, createCallableAgentToolSchema, parseCallableAgentManifest, type CallableAgentToolInput, type CallableAgentToolInputSchema, type CallableAgentToolManifestEntry, } from '../../shared/callable-agent-manifest.js';
export declare function isCallableAgentToolName(name: string): boolean;
export declare function createCallableAgentToolDefinitions(input: {
    manifest: readonly CallableAgentToolManifestEntry[];
    schema: CallableAgentToolInputSchema;
    dispatch(entry: CallableAgentToolManifestEntry, args: Record<string, unknown>): Promise<CoreTaskLifecycleResult>;
}): {
    name: string;
    description: string;
    inputSchema: CallableAgentToolInputSchema;
    handler: (args: Record<string, unknown>) => Promise<{
        isError?: boolean | undefined;
        error?: {
            category: "transient";
            isRetryable: boolean;
            message: string;
        } | {
            category: "validation";
            isRetryable: boolean;
            message: string;
        } | {
            category: "permission";
            isRetryable: boolean;
            message: string;
        } | {
            category: "business";
            isRetryable: boolean;
            message: string;
        } | undefined;
        content: {
            type: "text";
            text: string;
        }[];
    }>;
}[];
export declare function coreTaskLifecycleMcpResult(result: CoreTaskLifecycleResult): {
    isError?: boolean | undefined;
    error?: {
        category: "transient";
        isRetryable: boolean;
        message: string;
    } | {
        category: "validation";
        isRetryable: boolean;
        message: string;
    } | {
        category: "permission";
        isRetryable: boolean;
        message: string;
    } | {
        category: "business";
        isRetryable: boolean;
        message: string;
    } | undefined;
    content: {
        type: "text";
        text: string;
    }[];
};
export declare function projectCallableAgentTools(input: {
    agents: readonly Agent[];
    callerAppId: string;
    callerAgentId: string;
    callerFolder: string;
    delegates: readonly string[];
    conversationBoundAgentIds: ReadonlySet<string>;
    personasByAgentId?: Readonly<Record<string, string | undefined>>;
    toolPolicyRules?: readonly string[];
    parentTaskId?: string | null;
    warn?(context: Record<string, unknown>, message: string): void;
}): CallableAgentToolManifestEntry[];
export declare function conversationBoundAgentIdsForRoute(input: {
    routes: Record<string, ConversationRoute>;
    chatJid: string;
    threadId?: string | null;
    callerAgentId: string;
    callerProviderAccountId?: string | null;
}): ReadonlySet<string>;
export declare function conversationBoundAgentRoute(input: {
    routes: Record<string, ConversationRoute>;
    chatJid: string;
    threadId?: string | null;
    callerAgentId: string;
    callerProviderAccountId?: string | null;
    targetAgentId: string;
}): ConversationRoute | undefined;
export declare function preloadCallableAgentManifest(input: {
    run: {
        appId?: string;
        agentId?: string;
        parentTaskId?: string | null;
        toolPolicyRules?: readonly string[];
    };
    delegates: readonly string[];
    callerFolder: string;
    conversationBoundAgentIds: ReadonlySet<string>;
    personasByAgentId?: Readonly<Record<string, string | undefined>>;
    toolsAvailable: boolean;
    getRepository?: () => AgentRepository;
    warn?(context: Record<string, unknown>, message: string): void;
}): Promise<CallableAgentToolManifestEntry[]>;
export declare function dispatchCallableAgentTool(input: {
    args: Record<string, unknown>;
    entry: CallableAgentToolManifestEntry;
    backend: CoreTaskLifecycleBackend;
    revalidate(entry: CallableAgentToolManifestEntry): Promise<boolean>;
    narration?: {
        sourceAgentFolder: string;
        isScheduledJob?: boolean;
        deps: CoreSendMessageDeps & {
            warn(context: Record<string, unknown>, message: string): void;
        };
    };
}): Promise<CoreTaskLifecycleResult>;
