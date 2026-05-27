import { MemoryKind, MemoryScope } from './memory-types.js';
import type { AppId } from '../domain/app/app.js';

export interface ArcExtractionInput {
  appId: AppId;
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  trigger: 'precompact' | 'session-end';
  userId?: string;
  retrievedItems?: Array<{ id: string; key: string; value: string }>;
  onUsage?: (usage: MemoryExtractorUsage) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
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

export type MemoryExtractionStatus =
  | 'facts_extracted'
  | 'empty_qualified'
  | 'outcome_unavailable'
  | 'auth_unavailable'
  | 'sensitive_blocked'
  | 'extractor_failed';

export interface MemoryExtractionResult {
  facts: ExtractedMemoryFact[];
  status: MemoryExtractionStatus;
  zeroFactReason?: string;
  generatedMemory?: string;
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
  extractFactsWithOutcome?(
    input: ArcExtractionInput,
  ): MemoryExtractionResult | Promise<MemoryExtractionResult>;
}
