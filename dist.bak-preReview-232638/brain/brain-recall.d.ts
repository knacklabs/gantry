import type { BrainRankedPage, BrainRepository } from './brain-repository.js';
import type { BrainEmbeddingConfig } from './brain-types.js';
export declare const BRAIN_RRF_K = 60;
export declare function brainHybridCandidateLimit(limit: number): number;
export declare function recallBrainPages(input: {
    repository: BrainRepository;
    appId: string;
    query: string;
    limit?: number;
    queryVector?: number[] | null;
    embedding?: BrainEmbeddingConfig;
}): Promise<BrainRankedPage[]>;
