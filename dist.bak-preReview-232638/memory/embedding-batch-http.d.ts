import type { EmbeddingBatchPoll, EmbeddingBatchRequest, EmbeddingBatchResultRow } from './memory-embeddings.js';
interface Connection {
    apiKey: string;
    baseUrl: string;
}
/** Upload a JSONL batch file and create an async embeddings batch. */
export declare function submitEmbeddingBatch(conn: Connection, params: {
    model: string;
    dimensions: number;
    requests: EmbeddingBatchRequest[];
}, signal?: AbortSignal): Promise<{
    batchId: string;
}>;
export declare function pollEmbeddingBatch(conn: Connection, batchId: string, signal?: AbortSignal): Promise<EmbeddingBatchPoll>;
export declare function fetchEmbeddingBatchResults(conn: Connection, poll: EmbeddingBatchPoll, signal?: AbortSignal): Promise<EmbeddingBatchResultRow[]>;
export {};
