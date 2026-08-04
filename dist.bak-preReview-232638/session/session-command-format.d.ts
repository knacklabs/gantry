import type { ThinkingOverride } from '../domain/types.js';
import { type ModelCatalogFormatOptions } from '../shared/model-catalog-format.js';
export { formatModelWhy } from '../shared/model-why-format.js';
import type { RuntimeModelStatusSnapshot } from '../runtime/model-status-store.js';
export interface MemoryStatusSnapshot {
    memory_enabled?: boolean;
    items_by_kind: Record<string, number>;
    items_by_scope: Record<string, number>;
    top10_most_used: Array<{
        key: string;
        retrieval_count: number;
    }>;
    top10_stalest: Array<{
        key: string;
        updated_at: string;
    }>;
    last_dream_run?: {
        at?: string;
        summary?: string;
    };
    memory_pipeline?: {
        staged?: number;
        promoted?: number;
        needs_review?: number;
    };
    last_injected_block?: {
        subject?: string;
        bytes?: number;
        at?: string;
    };
    disk_kb?: Record<string, number>;
    retrieval?: {
        searchMode?: 'lexical_keyword' | 'hybrid_semantic_partial' | 'hybrid_semantic_ready';
        embeddings?: 'disabled' | 'configured';
        vectorSearch?: 'inactive' | 'partial' | 'active';
        pauseReason?: 'paused_budget' | 'paused_provider_quota' | 'paused_rate_limit' | 'paused_retryable_provider_error';
        ready?: number;
        pending?: number;
    };
}
export interface BrowserStatusSnapshot {
    profileName: string;
    profileLabel: string;
    running: boolean;
    cdpReady: boolean;
    profilePersistent?: boolean;
    userDataDir?: string;
    chromeExecutable?: string;
    hasState?: boolean;
    authMarkers?: string[];
    headless?: boolean;
    error?: string;
}
export interface CompactionStatusSnapshot {
    state: 'idle' | 'queued' | 'running' | 'ready' | 'degraded' | 'failed' | 'timeout';
}
export declare function formatCompactionStatus(status: CompactionStatusSnapshot): string;
export declare function formatBrowserStatus(status: BrowserStatusSnapshot): string;
export declare function formatMemoryStatus(status: MemoryStatusSnapshot): string;
export declare function describeThinking(value: ThinkingOverride): string;
export declare function formatCurrentModel(defaultModel: string | undefined, groupOverrideModel: string | undefined): string;
export declare function formatModelsList(options?: ModelCatalogFormatOptions): string;
export declare function formatModelStatus(snapshot: RuntimeModelStatusSnapshot | undefined, fallback: {
    currentModel?: string;
    defaultModel?: string;
    source: string;
}): string;
