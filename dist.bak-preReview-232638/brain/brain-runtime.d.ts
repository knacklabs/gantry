import { type BrainChannelHarvestTap } from './brain-channel-harvest.js';
import { type BrainDreamProposalPort } from './brain-dreaming.js';
import { BrainService } from './brain-service.js';
export declare function createRuntimeBrainService(appId: string): BrainService;
export declare function createRuntimeBrainChannelHarvestTap(): BrainChannelHarvestTap;
export declare function countRuntimeBrainHarvestEnabledConversations(): number;
export declare function runRuntimeBrainDreamBatch(input: {
    appId: string;
    limit?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    proposer?: BrainDreamProposalPort;
    observerEnabled?: boolean;
    observerOwnerRecipient?: string | null;
}): Promise<import("./brain-dreaming.js").BrainDreamBatchResult>;
export interface OpenedBrain {
    brain: BrainService;
    appId: string;
    harvestEnabledConversations: number;
    close: () => Promise<void>;
}
export declare function openBrainFromHome(runtimeHome: string): Promise<OpenedBrain>;
