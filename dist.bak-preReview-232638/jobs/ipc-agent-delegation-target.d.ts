import type { ConversationRoute } from '../domain/types.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { type CallableAgentToolManifestEntry } from '../application/core-tools/callable-agent-tools.js';
interface DelegatedTaskOwner {
    appId: string;
    agentId: string;
    conversationId: string;
    threadId?: string | null;
}
export declare function resolveDelegatedAgentTimeouts(payload: Record<string, unknown>, executionTimeoutMaxMs: number): {
    timeoutMs: number | undefined;
    syncWaitTimeoutMs: number | undefined;
};
export declare function resolveDelegatedAgentTarget(input: {
    deps: IpcDeps;
    routes: Record<string, ConversationRoute>;
    owner: DelegatedTaskOwner;
    sourceAgentFolder: string;
    trustedProviderAccountId?: string | null;
    requestedProviderAccountId?: string;
    targetAgentId?: string;
    callableAgentToolName?: unknown;
}): Promise<{
    ok: false;
    message: string;
    code: "forbidden";
    group?: undefined;
    targetAgentId?: undefined;
    targetOwner?: undefined;
    toolPolicy?: undefined;
    selectedSkillContext?: undefined;
    semanticCapabilities?: undefined;
    attachedMcpSourceIds?: undefined;
    callableAgentEntry?: undefined;
    providerAccountId?: undefined;
} | {
    ok: false;
    message: string;
    code: "not_found";
    group?: undefined;
    targetAgentId?: undefined;
    targetOwner?: undefined;
    toolPolicy?: undefined;
    selectedSkillContext?: undefined;
    semanticCapabilities?: undefined;
    attachedMcpSourceIds?: undefined;
    callableAgentEntry?: undefined;
    providerAccountId?: undefined;
} | {
    ok: true;
    group: ConversationRoute;
    targetAgentId: string;
    targetOwner: {
        agentId: string;
        appId: string;
        conversationId: string;
        threadId?: string | null;
    };
    toolPolicy: import("../runtime/configured-agent-tools.js").ConfiguredAgentToolPolicy;
    selectedSkillContext: {
        ids?: string[];
        displays?: string[];
    };
    semanticCapabilities: import("../shared/semantic-capabilities.js").SemanticCapabilityDefinition[];
    attachedMcpSourceIds: string[] | undefined;
    callableAgentEntry: CallableAgentToolManifestEntry | undefined;
    providerAccountId: string | null;
    message?: undefined;
    code?: undefined;
}>;
export {};
