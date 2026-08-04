import type { ExtractedMemoryFact, MemoryExtractionResult } from './extractor-types.js';
export declare function extractionResult(facts: ExtractedMemoryFact[], status?: MemoryExtractionResult['status'], zeroFactReason?: string | undefined): MemoryExtractionResult;
