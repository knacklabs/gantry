export declare const CALLABLE_AGENT_TOOL_PREFIX = "delegate_to_";
export declare const CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS = 60000;
export declare const CALLABLE_AGENT_SYNC_WAIT_MAX_MS = 60000;
export declare const CALLABLE_AGENT_RESPONSE_TIMEOUT_MS: number;
export declare const CALLABLE_AGENT_PERSONAS: readonly ["developer", "generalist", "sales", "marketing", "operations", "research"];
export type CallableAgentPersona = (typeof CALLABLE_AGENT_PERSONAS)[number];
export interface CallableAgentToolManifestEntry {
    toolName: string;
    targetAgentId: string;
    displayName: string;
    persona: CallableAgentPersona;
}
export interface CallableAgentToolInput extends Record<string, unknown> {
    objective: string;
    context?: string;
    expectedOutput?: string;
    timeoutMs?: number;
    syncWaitTimeoutMs?: number;
}
interface CallableAgentZodFactory {
    object(shape: Record<string, unknown>): any;
    string(): any;
    number(): any;
}
export interface CallableAgentToolInputSchema {
    safeParse(input: unknown): {
        success: true;
        data: CallableAgentToolInput;
    } | {
        success: false;
        error: {
            issues: Array<{
                message: string;
            }>;
        };
    };
}
export declare function callableAgentToolName(entry: CallableAgentToolManifestEntry): string;
export declare function callableAgentToolDescription(entry: CallableAgentToolManifestEntry): string;
export declare function createCallableAgentToolSchema(z: CallableAgentZodFactory): CallableAgentToolInputSchema;
export declare function parseCallableAgentManifest(raw: string | undefined, options?: {
    parentTaskId?: string;
    lockedPreset?: boolean;
    hideAuthorityTools?: boolean;
    asyncTaskToolsEnabled?: boolean;
    agentDelegationConfigured?: boolean;
}): CallableAgentToolManifestEntry[];
export {};
