import type { AppId } from '../app/app.js';

export interface MemoryLlmModelProfile {
  alias: string;
  runnerModel: string;
  responseFamily: string;
  modelRoute: string;
  modelRouteLabel: string;
  displayName: string;
}

export interface MemoryLlmQueryOpts {
  appId: AppId;
  model: string;
  modelProfile?: MemoryLlmModelProfile;
  prompt: string;
  systemPrompt?: string;
  userBlocks?: Array<{
    text: string;
    cacheStatic?: boolean;
  }>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onUsage?: (usage: MemoryLlmUsage) => void;
}

export interface MemoryLlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface MemoryLlmResponseSchema {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
}

export interface MemoryLlmBatchRequest {
  customId: string;
  prompt: string;
  systemPrompt?: string;
  userBlocks?: MemoryLlmQueryOpts['userBlocks'];
  responseSchema?: MemoryLlmResponseSchema;
}

export interface MemoryLlmBatchScope {
  appId: AppId;
  model: string;
  modelProfile?: MemoryLlmModelProfile;
  signal?: AbortSignal;
}

export interface MemoryLlmBatchSubmitOpts extends MemoryLlmBatchScope {
  correlationId: string;
  requests: MemoryLlmBatchRequest[];
  maxOutputTokens?: number;
  onSubmissionStart: () => Promise<void>;
}

export type MemoryLlmBatchState =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface MemoryLlmBatchPoll {
  batchId: string;
  state: MemoryLlmBatchState;
  error?: string;
}

export interface MemoryLlmBatchResultUsage extends MemoryLlmUsage {
  provider_reported_cost_usd: number | null;
}

export interface MemoryLlmBatchResultRow {
  customId: string;
  text?: string;
  usage?: MemoryLlmBatchResultUsage;
  error?: string;
}

export interface MemoryLlmBatchCapability {
  preflightBatch(
    opts: Omit<MemoryLlmBatchSubmitOpts, 'onSubmissionStart'>,
  ): Promise<void>;
  submitBatch(opts: MemoryLlmBatchSubmitOpts): Promise<{ batchId: string }>;
  pollBatch(
    opts: MemoryLlmBatchScope & { batchId: string },
  ): Promise<MemoryLlmBatchPoll>;
  fetchBatchResults(
    opts: MemoryLlmBatchScope & { batchId: string },
  ): Promise<MemoryLlmBatchResultRow[]>;
  findBatchByCorrelationId(
    opts: MemoryLlmBatchScope & { correlationId: string },
  ): Promise<{ batchId: string } | null>;
}

export interface MemoryLlmClient {
  isConfigured(): boolean;
  query(opts: MemoryLlmQueryOpts): Promise<string>;
  batch?: MemoryLlmBatchCapability;
}
