import type { AppMemorySearchInput } from './memory-types.js';
export declare const RRF_K = 60;
/** Per-branch candidate fan-out for Reciprocal Rank Fusion. */
export declare function hybridCandidateLimit(limit: number): number;
export interface HybridRecallDeps {
    schema: {
        memoryItemsPostgres: any;
    };
    sqlOps: {
        and: (...args: any[]) => any;
        asc: (value: any) => any;
        desc: (value: any) => any;
        eq: (left: any, right: any) => any;
        or: (...args: any[]) => any;
        sql: any;
    };
    embeddings: {
        provider: string;
        model: string;
        dimensions: number;
        memoryItemEmbeddingsPostgres: any;
    };
}
export interface HybridRankedRow {
    row: any;
    score: number;
    lexicalScore: number;
    vectorScore: number;
    reasons: string[];
}
/**
 * Hybrid recall: fuse lexical (full-text) and vector (pgvector cosine) candidate
 * lists with Reciprocal Rank Fusion. Returns at most `input.limit` ranked rows.
 * Callers only reach here when embeddings are enabled and a query embedding was
 * produced; otherwise recall stays lexical-only.
 */
export declare function runHybridRecall(db: any, input: AppMemorySearchInput, queryVector: number[], deps: HybridRecallDeps, options?: {
    signal?: AbortSignal;
    statementTimeoutMs?: number;
}): Promise<HybridRankedRow[]>;
