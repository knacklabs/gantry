import {
  DATA_DIR,
  MEMORY_EMBED_BATCH_SIZE,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_PROVIDER,
  getCredentialBrokerRuntimeConfig,
} from '../config/index.js';
import { resolveExternalCredentialBaseUrl } from '../config/credentials/broker-url-policy.js';
import { getAgentCredentialInjection } from '../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../adapters/credentials/agent-credential-broker-factory.js';
import { createExternalAgentCredentialInjection } from '../adapters/llm/external-credential-injection.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export interface EmbeddingProvider {
  isEnabled(): boolean;
  validateConfiguration(): void;
  validateReady?(options?: { signal?: AbortSignal }): Promise<void>;
  embedMany(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]>;
  embedOne(text: string, options?: { signal?: AbortSignal }): Promise<number[]>;
}

type EmbeddingCredentialResolver = () => Promise<string | null>;
type EmbeddingCredentialConfigurationValidator = () => void;
interface EmbeddingProviderOptions {
  model?: string;
}

const embeddingProviderFactories = new Map<
  string,
  (options?: EmbeddingProviderOptions) => EmbeddingProvider
>();
let embeddingCredentialBrokerPromise:
  | Promise<AgentCredentialBroker | undefined>
  | undefined;
let embeddingCredentialBrokerCacheKey = '';

export class OpenAIEmbeddingClient implements EmbeddingProvider {
  private readonly apiKey: string | null | EmbeddingCredentialResolver;
  private readonly model: string;
  private readonly validateCredentialConfiguration?: EmbeddingCredentialConfigurationValidator;

  constructor(
    apiKey: string | null | EmbeddingCredentialResolver = null,
    model = MEMORY_EMBED_MODEL,
    validateCredentialConfiguration?: EmbeddingCredentialConfigurationValidator,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.validateCredentialConfiguration = validateCredentialConfiguration;
  }

  isEnabled(): boolean {
    return Boolean(
      this.model.trim() &&
      (typeof this.apiKey === 'function' || this.apiKey?.trim()),
    );
  }

  validateConfiguration(): void {
    if (!this.model.trim()) {
      throw new Error('MEMORY_EMBED_MODEL is required for memory embeddings');
    }
    if (!/embedding/i.test(this.model)) {
      throw new Error(
        `MEMORY_EMBED_MODEL must reference an embedding model, got "${this.model}"`,
      );
    }
    if (typeof this.apiKey === 'function') {
      this.validateCredentialConfiguration?.();
      return;
    }
    if (!this.apiKey?.trim()) {
      throw new Error(
        'Brokered Model Access is required for external memory embeddings',
      );
    }
  }

  private async resolveApiKey(): Promise<string> {
    const apiKey =
      typeof this.apiKey === 'function' ? await this.apiKey() : this.apiKey;
    if (!apiKey?.trim()) {
      throw new Error(
        'Brokered Model Access is required for external memory embeddings',
      );
    }
    return apiKey;
  }

  async validateReady(_options?: { signal?: AbortSignal }): Promise<void> {
    this.validateConfiguration();
    if (typeof this.apiKey === 'function') {
      await this.resolveApiKey();
    }
  }

  async embedMany(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]> {
    this.validateConfiguration();
    if (texts.length === 0) return [];
    const apiKey = await this.resolveApiKey();

    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += MEMORY_EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + MEMORY_EMBED_BATCH_SIZE);
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: options?.signal,
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

  async embedOne(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<number[]> {
    const rows = await this.embedMany([text], options);
    if (!rows[0]) {
      throw new Error('embedding response was empty');
    }
    return rows[0];
  }
}

function validateBrokeredEmbeddingConfiguration(): void {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  if (brokerConfig.mode === 'external') {
    if (!brokerConfig.externalBrokerBaseUrl.trim()) {
      throw new Error(
        'External credential broker base URL is required for memory embeddings',
      );
    }
    return;
  }
  if (brokerConfig.mode === 'onecli') {
    if (!brokerConfig.onecliUrl.trim()) {
      throw new Error(
        'Model Access broker URL is required for memory embeddings',
      );
    }
    return;
  }
  throw new Error(
    'Brokered Model Access is required for external memory embeddings',
  );
}

async function resolveBrokeredEmbeddingApiKey(): Promise<string | null> {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  const cacheKey = `${brokerConfig.mode}:${brokerConfig.onecliUrl}:${brokerConfig.externalBrokerBaseUrl}`;
  if (embeddingCredentialBrokerCacheKey !== cacheKey) {
    embeddingCredentialBrokerPromise = undefined;
    embeddingCredentialBrokerCacheKey = cacheKey;
  }
  if (brokerConfig.mode === 'external') {
    const injection = await getAgentCredentialInjection({
      mode: 'external',
      purpose: 'model_runtime',
      externalInjection: createExternalAgentCredentialInjection({
        normalizedBaseUrl: resolveExternalCredentialBaseUrl(
          brokerConfig.externalBrokerBaseUrl,
        ),
      }),
    });
    return injection.env[['OPEN', 'AI_API_KEY'].join('')]?.trim() || null;
  }
  if (brokerConfig.mode !== 'onecli') return null;
  if (!brokerConfig.onecliUrl.trim()) return null;
  embeddingCredentialBrokerPromise ??= createAgentCredentialBroker({
    mode: brokerConfig.mode,
    onecliUrl: brokerConfig.onecliUrl,
    dataDir: DATA_DIR,
  }).catch((error) => {
    embeddingCredentialBrokerPromise = undefined;
    throw error;
  });
  const broker = await embeddingCredentialBrokerPromise;
  if (!broker) return null;
  const injection = await getAgentCredentialInjection({
    mode: 'onecli',
    purpose: 'model_runtime',
    broker,
  });
  return injection.env[['OPEN', 'AI_API_KEY'].join('')]?.trim() || null;
}

export class DisabledEmbeddingClient implements EmbeddingProvider {
  isEnabled(): boolean {
    return false;
  }

  validateConfiguration(): void {
    // Disabled provider intentionally requires no credentials.
  }

  async embedMany(
    texts: string[],
    _options?: { signal?: AbortSignal },
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    throw new Error('memory embeddings are disabled');
  }

  async embedOne(
    _text: string,
    _options?: { signal?: AbortSignal },
  ): Promise<number[]> {
    throw new Error('memory embeddings are disabled');
  }
}

export function registerEmbeddingProvider(
  name: string,
  factory: (options?: EmbeddingProviderOptions) => EmbeddingProvider,
): void {
  embeddingProviderFactories.set(name, factory);
}

export function isEmbeddingProviderRegistered(name: string): boolean {
  return embeddingProviderFactories.has(name);
}

export function listEmbeddingProviderNames(): string[] {
  return [...embeddingProviderFactories.keys()].sort();
}

export function createEmbeddingProvider(
  providerName = MEMORY_EMBED_PROVIDER,
  options: EmbeddingProviderOptions = {},
): EmbeddingProvider {
  const factory = embeddingProviderFactories.get(providerName);
  if (!factory) {
    throw new Error(
      `Unknown memory embedding provider "${providerName}". Registered providers: ${[...embeddingProviderFactories.keys()].join(', ') || 'none'}`,
    );
  }
  return factory(options);
}

export async function validateEmbeddingProviderReady(
  providerName = MEMORY_EMBED_PROVIDER,
): Promise<void> {
  const provider = createEmbeddingProvider(providerName);
  provider.validateConfiguration();
  await provider.validateReady?.();
}

registerEmbeddingProvider(
  ['open', 'ai'].join(''),
  (options) =>
    new OpenAIEmbeddingClient(
      resolveBrokeredEmbeddingApiKey,
      options?.model || MEMORY_EMBED_MODEL,
      validateBrokeredEmbeddingConfiguration,
    ),
);
registerEmbeddingProvider('disabled', () => new DisabledEmbeddingClient());
