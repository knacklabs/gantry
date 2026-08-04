import type { ArcExtractionInput, ExtractedMemoryFact, MemoryExtractionResult, MemoryExtractionProvider } from './extractor-types.js';
export declare class LlmMemoryExtractionProvider implements MemoryExtractionProvider {
    readonly providerName = "memory-llm";
    extractFacts(input: ArcExtractionInput): Promise<ExtractedMemoryFact[]>;
    extractFactsWithOutcome(input: ArcExtractionInput): Promise<MemoryExtractionResult>;
}
export declare function createLlmMemoryExtractionProvider(): MemoryExtractionProvider;
