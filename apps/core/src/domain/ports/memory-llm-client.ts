export interface MemoryLlmQueryOpts {
  model: string;
  prompt: string;
  systemPrompt?: string;
  userBlocks?: Array<{
    text: string;
    cacheStatic?: boolean;
  }>;
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
