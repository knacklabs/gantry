import crypto from 'crypto';
import { MEMORY_EMBED_DIMENSIONS, MEMORY_EMBED_MODEL, OPENAI_DAILY_EMBED_LIMIT, } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { EmbeddingProviderError } from './memory-embedding-errors.js';
import { nowDate } from '../shared/time/datetime.js';
let dailyApiCalls = 0;
let dailyResetDate = nowDate().toDateString();
function trackAndCheckBudget(callCount) {
    const today = nowDate().toDateString();
    if (today !== dailyResetDate) {
        dailyApiCalls = 0;
        dailyResetDate = today;
    }
    if (OPENAI_DAILY_EMBED_LIMIT > 0 &&
        dailyApiCalls + callCount > OPENAI_DAILY_EMBED_LIMIT) {
        logger.warn({
            dailyApiCalls,
            dailyLimit: OPENAI_DAILY_EMBED_LIMIT,
            requestedCalls: callCount,
        }, 'Daily embed limit reached. Skipping API call');
        return false;
    }
    dailyApiCalls += callCount;
    return true;
}
function dailyBudgetError() {
    return new EmbeddingProviderError('daily_budget', 'daily embedding budget reached');
}
export class CachedEmbeddingProvider {
    inner;
    store;
    model;
    dimensions;
    constructor(inner, store, model = MEMORY_EMBED_MODEL, dimensions = MEMORY_EMBED_DIMENSIONS) {
        this.inner = inner;
        this.store = store;
        this.model = model;
        this.dimensions = dimensions;
    }
    isEnabled() {
        return this.inner.isEnabled();
    }
    validateConfiguration() {
        this.inner.validateConfiguration();
    }
    async embedOne(text, options) {
        const hash = embeddingCacheTextHash(text);
        const cached = await this.store.getCachedEmbedding(hash, this.model, this.dimensions);
        if (cached)
            return cached;
        if (!trackAndCheckBudget(1)) {
            throw dailyBudgetError();
        }
        const embedding = await this.inner.embedOne(text, options);
        await this.store.putCachedEmbedding(hash, this.model, this.dimensions, embedding);
        return embedding;
    }
    async embedMany(texts, options) {
        if (texts.length === 0)
            return [];
        const results = new Array(texts.length).fill(null);
        const misses = new Map();
        await Promise.all(texts.map(async (text, index) => {
            const hash = embeddingCacheTextHash(text);
            const cached = await this.store.getCachedEmbedding(hash, this.model, this.dimensions);
            if (cached) {
                results[index] = cached;
                return;
            }
            const existing = misses.get(hash);
            if (existing) {
                existing.indexes.push(index);
                return;
            }
            misses.set(hash, { text, indexes: [index] });
        }));
        if (misses.size > 0) {
            const missEntries = [...misses.entries()];
            const missingTexts = missEntries.map(([, value]) => value.text);
            if (!trackAndCheckBudget(missingTexts.length)) {
                throw dailyBudgetError();
            }
            const embeddings = await this.inner.embedMany(missingTexts, options);
            if (embeddings.length !== missEntries.length) {
                throw new Error(`embedding provider returned ${embeddings.length} vectors for ${missEntries.length} uncached texts`);
            }
            await Promise.all(missEntries.map(async ([hash, value], index) => {
                const embedding = embeddings[index];
                if (!embedding)
                    return;
                await this.store.putCachedEmbedding(hash, this.model, this.dimensions, embedding);
                for (const resultIndex of value.indexes) {
                    results[resultIndex] = embedding;
                }
            }));
        }
        return results.map((embedding, index) => {
            if (!embedding) {
                throw new Error(`missing embedding at index ${index}`);
            }
            return embedding;
        });
    }
}
export function embeddingCacheTextHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}
