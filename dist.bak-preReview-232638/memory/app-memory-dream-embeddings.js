import { and, eq } from 'drizzle-orm';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { MEMORY_EMBED_DIMENSIONS } from '../config/memory.js';
import { runWithMemoryOperationTimeout } from '../shared/memory-dreaming-timeout.js';
import { embeddingTextForMemory } from './app-memory-service-helpers.js';
import { markEmbeddingState, writeReadyEmbedding, } from './app-memory-embedding-writes.js';
export const DREAM_EMBEDDING_DEADLINE_MS = 15_000;
export async function runWithTimeout(operation, timeoutMs, options = {}) {
    return runWithMemoryOperationTimeout(operation, {
        timeoutMs,
        label: options.label ?? 'dream embedding',
        parentSignal: options.signal,
    });
}
const Embeddings = pgSchema.memoryItemEmbeddingsPostgres;
export async function storeDreamItemEmbedding(input) {
    const now = input.now();
    const dimensions = input.dimensions ??
        input.provider.expectedDimensions?.() ??
        MEMORY_EMBED_DIMENSIONS;
    const key = {
        itemId: input.item.id,
        provider: input.providerName,
        model: input.model,
        dimensions,
        contentHash: input.contentHash,
    };
    const [existing] = await input.db
        .select({ status: Embeddings.status })
        .from(Embeddings)
        .where(and(eq(Embeddings.itemId, input.item.id), eq(Embeddings.provider, input.providerName), eq(Embeddings.model, input.model), eq(Embeddings.contentHash, input.contentHash)))
        .limit(1);
    if (existing?.status === 'ready') {
        return { status: 'stored' };
    }
    const embeddingText = embeddingTextForMemory(input.item);
    const timeoutMs = Math.max(1, input.timeoutMs ?? DREAM_EMBEDDING_DEADLINE_MS);
    try {
        const embedding = await runWithTimeout((signal) => input.provider.embedOne(embeddingText, { signal }), timeoutMs, { signal: input.signal });
        await writeReadyEmbedding(input.db, key, embedding, now, null);
        return { status: 'stored' };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown embedding error';
        await markEmbeddingState(input.db, key, 'retryable_error', now, {
            error: reason.slice(0, 500),
        });
        return {
            status: 'retryable',
            reason,
        };
    }
}
