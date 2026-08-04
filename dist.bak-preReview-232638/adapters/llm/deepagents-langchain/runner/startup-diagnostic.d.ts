import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import type { CachePromptControlMode } from './cache-control.js';
import type { DeepAgentCheckpointTimingSnapshot } from './session-store.js';
import type { DeepAgentRunnerInput } from './types.js';
export type DeepAgentStartupPhase = 'modelBuildMs' | 'systemPromptMs' | 'permissionEnvMs' | 'mcpConnectMs' | 'graphCreateMs' | 'turnMessagesMs' | 'streamIteratorMs' | 'streamNormalizeMs';
export interface DeepAgentStartupTimingSnapshot {
    totalMs: number;
    phases: Partial<Record<DeepAgentStartupPhase, number>>;
    toolsReadyMs?: number;
    firstLangGraphEventMs?: number;
    firstLangGraphEventName?: string;
    firstVisibleOutputMs?: number;
    firstToolStartMs?: number;
    toolStartCount: number;
}
export declare function createDeepAgentStartupTiming(input: {
    nowMs: () => number;
}): {
    measure: <T>(phase: DeepAgentStartupPhase, work: () => T) => T;
    measureAsync: <T>(phase: DeepAgentStartupPhase, work: () => Promise<T>) => Promise<T>;
    markFirstLangGraphEvent: (eventName: string) => void;
    markFirstVisibleOutput: () => void;
    markToolsReady: () => void;
    markToolStart: () => void;
    snapshot: () => DeepAgentStartupTimingSnapshot;
};
export declare function buildDeepAgentStartupDiagnosticEvent(input: {
    agentInput: DeepAgentRunnerInput;
    modelProvider: string;
    modelId: string;
    endpointFamily: 'openai' | 'openrouter';
    timing: DeepAgentStartupTimingSnapshot;
    selectedAllowedToolCount: number;
    connectedToolCount: number;
    systemPromptChars: number;
    memoryContextChars: number;
    turnMessageCount: number;
    cacheMode: CachePromptControlMode;
    checkpointerConfigured: boolean;
    deepAgentSkillSourceCount?: number;
    deepAgentSkillFileCount?: number;
    deepAgentSkillContentBytes?: number;
    deepAgentSkillReadToolsEnabled?: boolean;
    checkpointTiming?: DeepAgentCheckpointTimingSnapshot;
    scheduledJob: boolean;
}): NonNullable<RunnerOutputFrame['runtimeEvents']>[number];
