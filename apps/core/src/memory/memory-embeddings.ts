import {
  MEMORY_EMBED_BATCH_SIZE,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_PROVIDER,
  MEMORY_VECTOR_DIMENSIONS,
  OPENAI_API_KEY,
} from '../core/config.js';

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export interface EmbeddingProvider {
  isEnabled(): boolean;
  validateConfiguration(): void;
  embedMany(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

type EmbeddingProviderFactory = () => EmbeddingProvider;

const embeddingProviderFactories = new Map<string, EmbeddingProviderFactory>();

export class OpenAIEmbeddingClient implements EmbeddingProvider {
  private readonly apiKey: string | null;
  private readonly model: string;

  constructor(apiKey = OPENAI_API_KEY, model = MEMORY_EMBED_MODEL) {
    this.apiKey = apiKey;
    this.model = model;
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey?.trim() && this.model.trim());
  }

  validateConfiguration(): void {
    if (!this.apiKey?.trim()) {
      throw new Error('OPENAI_API_KEY is required for memory embeddings');
    }
    if (!this.model.trim()) {
      throw new Error('MEMORY_EMBED_MODEL is required for memory embeddings');
    }
    if (!/embedding/i.test(this.model)) {
      throw new Error(
        `MEMORY_EMBED_MODEL must reference an embedding model, got "${this.model}"`,
      );
    }
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    this.validateConfiguration();

    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += MEMORY_EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + MEMORY_EMBED_BATCH_SIZE);
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `embedding request failed (${res.status}): ${text.slice(0, 200)}`,
        );
      }

      const json = (await res.json()) as EmbeddingResponse;
      if (!Array.isArray(json.data) || json.data.length !== batch.length) {
        throw new Error(
          `embedding response size mismatch: expected ${batch.length}, got ${json.data?.length ?? 0}`,
        );
      }
      for (const row of json.data) {
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
          throw new Error(
            'embedding response contained invalid embedding vector',
          );
        }
        all.push(row.embedding);
      }
    }

    return all;
  }

  async embedOne(text: string): Promise<number[]> {
    const rows = await this.embedMany([text]);
    if (!rows[0]) {
      throw new Error('embedding response was empty');
    }
    return rows[0];
  }
}

export class DisabledEmbeddingClient implements EmbeddingProvider {
  isEnabled(): boolean {
    return false;
  }

  validateConfiguration(): void {
    // Disabled provider intentionally requires no credentials.
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const zeroVector = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    return texts.map(() => [...zeroVector]);
  }

  async embedOne(_text: string): Promise<number[]> {
    return new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
  }
}

export function registerEmbeddingProvider(
  name: string,
  factory: EmbeddingProviderFactory,
): void {
  embeddingProviderFactories.set(name, factory);
}

export function createEmbeddingProvider(
  providerName = MEMORY_EMBED_PROVIDER,
): EmbeddingProvider {
  const factory = embeddingProviderFactories.get(providerName);
  if (!factory) {
    throw new Error(
      `Unknown memory embedding provider "${providerName}". Registered providers: ${[...embeddingProviderFactories.keys()].join(', ') || 'none'}`,
    );
  }
  return factory();
}

registerEmbeddingProvider('openai', () => new OpenAIEmbeddingClient());
registerEmbeddingProvider('disabled', () => new DisabledEmbeddingClient());
registerEmbeddingProvider('none', () => new DisabledEmbeddingClient());
