import type { AgentRunnerInput, AgentRunnerRuntimeEventOutput } from './types.js';
export declare function runnerStartupTimingRuntimeEvent(input: {
    agentInput: AgentRunnerInput;
    persistSdkSession: boolean;
    resumedSession: boolean;
    sdkQueryPreparedMs: number;
    sdkQueryIteratorMs: number;
    firstSdkEventMs?: number;
    providerSessionMs?: number;
    firstVisibleOutputMs?: number;
    firstResultMs?: number;
    messageCount: number;
    resultCount: number;
    availableToolCount: number;
    allowedToolCount: number;
    disallowedToolCount: number;
    mcpServerCount: number;
}): AgentRunnerRuntimeEventOutput;
