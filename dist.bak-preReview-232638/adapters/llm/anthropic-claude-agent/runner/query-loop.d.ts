import { type EffortLevel, type ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunnerInput, AgentRunnerToolAttemptOutput } from './types.js';
export { recordSuccessfulToolUse } from './query-tool-success-ledger.js';
interface RunQueryOptions {
    enableIpcFollowups?: boolean;
    persistSdkSession?: boolean;
}
export declare function runQuery(prompt: string, mcpServerPath: string, agentInput: AgentRunnerInput, sdkEnv: Record<string, string | undefined>, configuredModel: string | undefined, queryThinking: ThinkingConfig | undefined, queryEffort: EffortLevel | undefined, options?: RunQueryOptions): Promise<{
    newSessionId?: string;
    lastAssistantUuid?: string;
    closedDuringQuery: boolean;
    primeToolAttempts: AgentRunnerToolAttemptOutput[];
}>;
