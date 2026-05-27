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

export interface MemoryLlmClient {
  isConfigured(): boolean;
  query(opts: MemoryLlmQueryOpts): Promise<string>;
}
