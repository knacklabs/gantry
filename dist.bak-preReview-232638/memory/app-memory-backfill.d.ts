import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { MemoryBackfillMode } from '../config/settings/runtime-settings-types.js';
import { type BackfillRunStatus } from './app-memory-backfill-runs.js';
import { type EmbeddingErrorCode, type EmbeddingPauseReason } from './memory-embedding-errors.js';
import type { EmbeddingProvider } from './memory-embeddings.js';
type Db = NodePgDatabase<typeof pgSchema>;
export interface RunBackfillInput {
    db: Db;
    appId: string;
    agentId?: string | null;
    trigger: 'cli' | 'schedule';
    provider: string;
    model: string;
    dimensions: number;
    batchSize: number;
    dailyLimit: number;
    maxItemsPerRun: number;
    providerBatchMinItems: number;
    mode: MemoryBackfillMode;
    limit?: number;
    embeddingProvider: EmbeddingProvider;
    signal?: AbortSignal;
    now?: () => string;
}
export interface BackfillResult {
    runId: string;
    status: BackfillRunStatus;
    mode: 'inline' | 'provider_batch';
    totalCandidates: number;
    indexed: number;
    skippedReady: number;
    pending: number;
    submitted: number;
    pauseReason?: EmbeddingPauseReason;
    errorCode?: EmbeddingErrorCode;
    errorMessage?: string;
    alreadyRunning?: boolean;
    pausedByPriorRun?: boolean;
    scanTruncated: boolean;
}
/**
 * Run (or resume) an embedding backfill for an app/agent scope. Inline mode
 * embeds in chunks and pauses resumably on quota/budget/rate-limit/retryable
 * errors; provider_batch mode submits an async provider batch that scheduled
 * polling later imports. Returns a structured outcome for CLI/status surfaces.
 */
export declare function runEmbeddingBackfill(input: RunBackfillInput): Promise<BackfillResult>;
export {};
