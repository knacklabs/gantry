import type { BaseMessage } from '@langchain/core/messages';
import { type OpenRouterProviderPreferences } from './model-factory.js';
import type { DeepAgentRunnerInput } from './types.js';
import { RunScopedToolSuccessLedger } from '../../../../runner/tool-gate-core.js';
import type { DeepAgentCheckpointSaver, DeepAgentCheckpointTiming } from './session-store.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
export interface DeepAgentTurnResult {
    text: string;
    terminalResult: string | null;
    terminalUsage: RunnerOutputFrame['usage'];
    terminalContextUsage: RunnerOutputFrame['contextUsage'];
    startupRuntimeEvents?: RunnerOutputFrame['runtimeEvents'];
}
export declare function runDeepAgentTurn(input: {
    agentInput: DeepAgentRunnerInput;
    provider: string;
    modelId: string;
    maxInputTokens?: number;
    openRouterProviderRouting?: OpenRouterProviderPreferences;
    newSessionId: string;
    threadId?: string;
    checkpointer?: DeepAgentCheckpointSaver;
    checkpointTiming?: DeepAgentCheckpointTiming;
    includeMemoryContext: boolean;
    toolSuccessLedger?: RunScopedToolSuccessLedger;
    emit: (frame: RunnerOutputFrame) => void;
    log?: (message: string) => void;
    onToolStart?: (toolName: string) => void;
    signal?: AbortSignal;
}): Promise<DeepAgentTurnResult>;
export declare function buildTurnMessages(agentInput: DeepAgentRunnerInput, options?: {
    includeMemoryContext?: boolean;
}): BaseMessage[];
