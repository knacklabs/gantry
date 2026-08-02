import type { MemoryLlmModelProfile } from '../domain/ports/memory-llm-client.js';
export { RUNTIME_MEMORY_DREAMING_ALERTS_ENABLED, RUNTIME_MEMORY_DREAMING_ENABLED, RUNTIME_MEMORY_ENABLED, } from './memory-state.js';
export * from './memory-advanced.js';
export declare const OPENAI_DAILY_EMBED_LIMIT: number;
export declare const MEMORY_EMBED_MODEL: string;
export declare const MEMORY_EMBED_DIMENSIONS: number;
export declare const MEMORY_EMBED_PROVIDER: string;
export declare const MEMORY_DREAMING_EMBEDDINGS_ENABLED: boolean;
export declare const MEMORY_DREAMING_EMBED_PROVIDER: string;
export declare const MEMORY_DREAMING_EMBED_MODEL: string;
export declare const MEMORY_EXTRACTOR_MAX_FACTS: number;
export declare const MEMORY_EXTRACTOR_MIN_CONFIDENCE: number;
export declare function getMemoryModelConfig(fallbackModel: string | undefined): {
    extractor: string;
    dreaming: string;
    consolidation: string;
    modelProfiles: {
        extractor?: MemoryLlmModelProfile;
        dreaming?: MemoryLlmModelProfile;
        consolidation?: MemoryLlmModelProfile;
    };
};
