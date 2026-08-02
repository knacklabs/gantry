import type { EmbeddingProvider } from '../memory/memory-embeddings.js';
import type { BrainEdge, BrainEmbeddingConfig, BrainEntity, BrainPage, BrainPageSourceKind, BrainQueryResult, BrainSearchResult } from './brain-types.js';
import { type BrainSynthesisPort } from './brain-synthesis.js';
import type { BrainRepository } from './brain-repository.js';
export interface BrainServiceDeps {
    embedding?: {
        config: BrainEmbeddingConfig;
        provider: EmbeddingProvider;
    };
    synthesis?: BrainSynthesisPort;
}
export interface BrainWriteInput {
    appId: string;
    slug: string;
    markdown: string;
    title?: string;
    sourceKind?: BrainPageSourceKind;
    sourceRef?: string | null;
    authorId?: string | null;
    embed?: boolean;
}
export interface BrainWriteResult {
    page: BrainPage;
    created: boolean;
    entities: BrainEntity[];
    edges: BrainEdge[];
}
export declare class BrainService {
    private readonly repository;
    private readonly deps;
    private readonly synthesis;
    constructor(repository: BrainRepository, deps?: BrainServiceDeps);
    write(input: BrainWriteInput): Promise<BrainWriteResult>;
    getPageBySlug(appId: string, slug: string): Promise<BrainPage | null>;
    search(input: {
        appId: string;
        query: string;
        limit?: number;
    }): Promise<BrainSearchResult[]>;
    query(input: {
        appId: string;
        question: string;
        limit?: number;
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<BrainQueryResult>;
    status(appId: string): Promise<import("./brain-types.js").BrainStatus>;
    backfillEmbeddings(input: {
        appId: string;
        limit?: number;
        signal?: AbortSignal;
    }): Promise<{
        indexed: number;
        pending: number;
        skipped: number;
    }>;
    private withGraph;
    private embedPageIfEnabled;
    private embedQuery;
    private tryEdgeQuestion;
}
