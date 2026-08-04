import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunnerInput, AgentRunnerToolAttemptOutput, RunnerCapabilitiesForPermission } from './types.js';
interface CreateCanUseToolCallbackInput {
    agentInput: AgentRunnerInput;
    sdkEnv: Record<string, string | undefined>;
    workspaceFolder: string;
    memoryBlock: string;
    configuredModel?: string;
    capabilities: RunnerCapabilitiesForPermission;
    primeToolAttempts: AgentRunnerToolAttemptOutput[];
    getNewSessionId: () => string | undefined;
    emitInteractionBoundary: () => void;
    recordToolActivity: (toolName: string) => void;
    recordPermissionApprovalContext?: (toolUseID: string, additionalContext: string) => void;
}
export declare function createPermissionApprovalContextChannel(): {
    record: (toolUseID: string, context: string) => Map<string, string>;
    postToolUse: HookCallback;
};
export declare function createCanUseToolCallback(input: CreateCanUseToolCallbackInput): CanUseTool;
export {};
