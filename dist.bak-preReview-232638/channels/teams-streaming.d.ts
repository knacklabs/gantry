import type { StreamingChunkOptions } from '../domain/types.js';
import type { TeamsSdkClient } from './teams-types.js';
export interface TeamsStreamingState {
    conversationId: string;
    messageId?: string;
    rawBuffer: string;
    lastFlushAt: number;
    pendingDelivery: Promise<boolean>;
}
export declare function applyTeamsStreamingChunk(input: {
    jid: string;
    key: string;
    state: TeamsStreamingState;
    text: string;
    options: StreamingChunkOptions;
    activeStreams: Map<string, TeamsStreamingState>;
    sdkClient: TeamsSdkClient;
    markDone: (jid: string, generation?: number) => void;
    shouldContinue: () => boolean;
}): Promise<boolean>;
