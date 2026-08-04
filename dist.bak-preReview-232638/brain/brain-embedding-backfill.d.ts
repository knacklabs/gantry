import type { BrainService } from './brain-service.js';
export declare function runBrainEmbeddingBackfill(input: {
    brain: BrainService;
    appId: string;
    limit?: number;
    signal?: AbortSignal;
}): Promise<string>;
