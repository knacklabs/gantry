import type { AgentControlOverrides, ConversationRoute } from '../domain/types.js';
import type { AgentOutput } from './agent-spawn.js';
import type { GroupProcessingDeps, GroupProcessingRepository } from './group-processing-types.js';
export type GroupAgentRunResult = 'success' | 'error' | 'stopped';
export declare function createGroupAgentRunner(input: {
    deps: GroupProcessingDeps;
    ops: () => GroupProcessingRepository;
}): (...args: Parameters<(group: ConversationRoute, prompt: string, chatJid: string, queueJid: string, onOutput?: (output: AgentOutput) => Promise<void>, options?: {
    timeoutMs?: number;
    memoryContext?: {
        source: "message" | "command";
        userId?: string;
        threadId?: string;
        recallQuery?: string;
    };
    turnMessages?: readonly {
        id?: string;
        content?: string | null;
        sender?: string | null;
        timestamp?: string;
        is_from_me?: boolean | null;
    }[];
    existingRunId?: string;
    existingRunLeaseToken?: string;
    existingRunLeaseWorkerInstanceId?: string;
    existingRunLeaseFencingVersion?: number;
    liveStopActionToken?: string;
    maintenanceProviderSession?: {
        providerSessionId: string;
        externalSessionId: string;
    };
    maintenanceCompaction?: boolean;
    responseSchema?: Record<string, unknown>;
    agentControls?: AgentControlOverrides;
}) => Promise<GroupAgentRunResult>>) => Promise<GroupAgentRunResult>;
