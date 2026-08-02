import type { BrainCitation, BrainSearchResult } from './brain-types.js';
export interface BrainSynthesisInput {
    appId: string;
    question: string;
    results: BrainSearchResult[];
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface BrainSynthesisOutput {
    answer: string;
    citations: BrainCitation[];
    gaps: string;
}
export interface BrainSynthesisPort {
    synthesize(input: BrainSynthesisInput): Promise<BrainSynthesisOutput>;
}
export declare class MemoryLlmBrainSynthesis implements BrainSynthesisPort {
    synthesize(input: BrainSynthesisInput): Promise<BrainSynthesisOutput>;
}
export declare function parseBrainSynthesisOutput(text: string, fallback: BrainSynthesisOutput, results: BrainSearchResult[]): BrainSynthesisOutput;
