import { type BrainDreamProposalPort } from './brain-dream-proposer.js';
import type { BrainRepository } from './brain-repository.js';
import type { BrainService } from './brain-service.js';
import type { ObserverInsightEmissionRuntime } from './observer-insight-emission.js';
import { type BrainPage } from './brain-types.js';
export { dreamMarkdownWindow, MemoryLlmBrainDreamProposer, type BrainDreamProposal, type BrainDreamProposalPort, } from './brain-dream-proposer.js';
export type BrainDreamOutcome = 'applied' | 'noop' | 'rejected' | 'proposed';
export interface BrainDreamBatchResult {
    runId: string;
    pages: number;
    applied: number;
    noop: number;
    rejected: number;
    proposed: number;
    observer?: {
        persisted: number;
        deduplicated: number;
        filtered: number;
        message: string;
    };
}
export declare function runBrainDreamBatch(input: {
    brain: BrainService;
    repository: BrainRepository;
    appId: string;
    proposer?: BrainDreamProposalPort;
    limit?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    observer?: ObserverInsightEmissionRuntime;
}): Promise<BrainDreamBatchResult>;
export declare function applyBrainDreamOperations(input: {
    brain: BrainService;
    repository: BrainRepository;
    appId: string;
    runId: string;
    page?: BrainPage;
    evidencePages: BrainPage[];
    ops: unknown[];
    signal?: AbortSignal;
}): Promise<Omit<BrainDreamBatchResult, 'runId' | 'pages'>>;
