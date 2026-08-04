import type { AppMemoryItem, AppMemorySearchInput, AppMemorySearchResult, NormalizedMemorySubject } from './memory-types.js';
export type AppMemorySearchEmptyReason = 'no_visible_subject_filters' | 'no_matching_memory';
export interface AppMemorySearchOutcome {
    resolvedSubject: NormalizedMemorySubject;
    empty_reason?: AppMemorySearchEmptyReason;
}
interface AppMemoryRecallDeps {
    schema: {
        memoryItemsPostgres: any;
        memoryRecallEventsPostgres: any;
    };
    sqlOps: {
        and: (...args: any[]) => any;
        asc: (value: any) => any;
        desc: (value: any) => any;
        eq: (left: any, right: any) => any;
        or: (...args: any[]) => any;
        sql: any;
    };
    /**
     * Optional hybrid-recall capability. When present and `enabled`, ranked
     * non-empty queries fuse lexical + vector candidates; otherwise recall stays
     * lexical-only. `embedQuery` returns null to signal a lexical fallback
     * (budget/quota/rate-limit/provider error).
     */
    embeddings?: {
        enabled: boolean;
        provider: string;
        model: string;
        dimensions: number;
        memoryItemEmbeddingsPostgres: any;
        embedQuery: (query: string, signal?: AbortSignal) => Promise<number[] | null>;
    };
}
export declare function describeAppMemorySearchOutcome(input: AppMemorySearchInput, resultCount: number): AppMemorySearchOutcome;
export declare function queryAppMemoryItems(db: any, input: AppMemorySearchInput, ranked: boolean, deps: AppMemoryRecallDeps, options?: {
    signal?: AbortSignal;
    statementTimeoutMs?: number;
}): Promise<Array<{
    row: any;
    score: number;
    lexicalScore: number;
    vectorScore: number;
    reasons: string[];
}>>;
export declare function toAppMemoryItems(rows: Array<{
    row: any;
}>): AppMemoryItem[];
export declare function toAppMemorySearchResults(rows: Array<{
    row: any;
    score: number;
    lexicalScore: number;
    vectorScore: number;
    reasons: string[];
}>): AppMemorySearchResult[];
export declare function recordAppMemoryRecallEvents(db: any, input: AppMemorySearchInput, results: AppMemorySearchResult[], deps: AppMemoryRecallDeps): Promise<void>;
export {};
