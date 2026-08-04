import type { BrainPage } from './brain-types.js';
export interface BrainDreamProposalPort {
    propose(input: {
        appId: string;
        pages: BrainPage[];
        observerEnabled?: boolean;
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<unknown[] | BrainDreamProposal>;
}
export interface BrainDreamProposal {
    operations: unknown[];
    surfaceableInsights: unknown[];
}
export declare class MemoryLlmBrainDreamProposer implements BrainDreamProposalPort {
    propose(input: {
        appId: string;
        pages: BrainPage[];
        observerEnabled?: boolean;
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<unknown[] | BrainDreamProposal>;
}
export declare function dreamMarkdownWindow(markdown: string): string;
