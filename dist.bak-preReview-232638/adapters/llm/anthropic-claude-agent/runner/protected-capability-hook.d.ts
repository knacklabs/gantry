import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
export interface ProtectedCapabilityDecision {
    reason: string;
    recoveryAction?: string;
}
export declare function evaluateProtectedCapabilityToolUse(toolName: string, input: unknown): ProtectedCapabilityDecision | null;
export declare function protectedCapabilityPreToolUseHook(input: HookInput): Promise<SyncHookJSONOutput>;
export declare function createSafetyPreToolUseHook(memoryBlock: string, toolNetworkEnv?: Record<string, string | undefined>): (input: HookInput) => Promise<SyncHookJSONOutput>;
