import type { AgentOutput } from './agent-spawn-types.js';
interface RuntimeModelStatusGroup {
    folder: string;
    agentConfig?: {
        model?: string | null;
    } | null;
}
export declare function recordRuntimeModelUsage(input: {
    group: RuntimeModelStatusGroup;
    threadId: string | null;
    usage: NonNullable<AgentOutput['usage']>;
    usageEventId?: string;
    getDefaultModel: () => string | undefined;
}): void;
export {};
