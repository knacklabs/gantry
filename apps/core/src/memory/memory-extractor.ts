import { MemoryKind, MemoryScope } from './memory-types.js';
import { createLlmMemoryExtractionProvider } from './extractor-llm.js';

export interface ArcExtractionInput {
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  trigger: 'precompact' | 'session-end';
  userId?: string;
  retrievedItems?: Array<{ id: string; key: string; value: string }>;
  onUsage?: (usage: MemoryExtractorUsage) => void;
}

export interface MemoryExtractorUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ExtractedMemoryFact {
  scope: MemoryScope;
  kind: ExtractableMemoryKind;
  key: string;
  value: string;
  confidence: number;
  user_id?: string;
  why?: string;
  load_bearing?: boolean;
  source_turn_id?: string;
  supersedes?: string[];
}

export type ExtractableMemoryKind = Extract<
  MemoryKind,
  'preference' | 'decision' | 'fact' | 'correction' | 'constraint'
>;

export interface MemoryExtractionProvider {
  providerName: string;
  extractFacts(
    input: ArcExtractionInput,
  ): ExtractedMemoryFact[] | Promise<ExtractedMemoryFact[]>;
}

export function createMemoryExtractionProvider(): MemoryExtractionProvider {
  return createLlmMemoryExtractionProvider();
}
