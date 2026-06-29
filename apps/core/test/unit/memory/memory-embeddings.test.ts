import { afterEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_EMBED_BATCH_SIZE } from '@core/config/index.js';

import {
  createEmbeddingProvider,
  DisabledEmbeddingClient,
  OpenAIEmbeddingClient,
} from '@core/memory/memory-embeddings.js';

describe('memory embedding providers', () => {
  it('creates openai provider from factory', () => {
    const provider = createEmbeddingProvider('openai');
    expect(provider).toBeInstanceOf(OpenAIEmbeddingClient);
  });

  it('throws for unknown provider name', () => {
    expect(() => createEmbeddingProvider('does-not-exist')).toThrow(
      /Unknown memory embedding provider/,
    );
  });

  it('does not synthesize zero vectors when disabled', async () => {
    const provider = new DisabledEmbeddingClient();

    expect(provider.isEnabled()).toBe(false);
    await expect(provider.embedMany(['hello'])).rejects.toThrow(
      'memory embeddings are disabled',
    );
    await expect(provider.embedOne('hello')).rejects.toThrow(
      'memory embeddings are disabled',
    );
    await expect(provider.embedMany([])).resolves.toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  OpenAIEmbeddingClient unit tests                                          */
/* -------------------------------------------------------------------------- */

describe('OpenAIEmbeddingClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ---- isEnabled --------------------------------------------------------- */

  describe('isEnabled()', () => {
    it('returns false when no API key', () => {
      const client = new OpenAIEmbeddingClient(
        null as unknown as string,
        'text-embedding-test',
      );
      expect(client.isEnabled()).toBe(false);
    });

    it('returns false when API key is empty/whitespace', () => {
      const client = new OpenAIEmbeddingClient('  ', 'text-embedding-test');
      expect(client.isEnabled()).toBe(false);
    });

    it('returns false when model is empty', () => {
      const client = new OpenAIEmbeddingClient('test-key', '');
      expect(client.isEnabled()).toBe(false);
    });

    it('returns false when model is whitespace-only', () => {
      const client = new OpenAIEmbeddingClient('test-key', '   ');
      expect(client.isEnabled()).toBe(false);
    });

    it('returns true when both key and model are set', () => {
      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      expect(client.isEnabled()).toBe(true);
    });

    it('returns true for brokered credential resolvers with an embedding model', () => {
      const client = new OpenAIEmbeddingClient(
        async () => 'brokered-key',
        'text-embedding-test',
      );
      expect(client.isEnabled()).toBe(true);
    });
  });

  /* ---- validateConfiguration --------------------------------------------- */

  describe('validateConfiguration()', () => {
    it('throws when API key is missing', () => {
      const client = new OpenAIEmbeddingClient(
        null as unknown as string,
        'text-embedding-test',
      );
      expect(() => client.validateConfiguration()).toThrow(
        'Brokered Model Access is required for external memory embeddings',
      );
    });

    it('throws when API key is empty', () => {
      const client = new OpenAIEmbeddingClient('', 'text-embedding-test');
      expect(() => client.validateConfiguration()).toThrow(
        'Brokered Model Access is required for external memory embeddings',
      );
    });

    it('throws when model is empty', () => {
      const client = new OpenAIEmbeddingClient('test-key', '');
      expect(() => client.validateConfiguration()).toThrow(
        'MEMORY_EMBED_MODEL is required for memory embeddings',
      );
    });

    it('throws when model does not contain "embedding"', () => {
      const client = new OpenAIEmbeddingClient('test-key', 'gpt-4o');
      expect(() => client.validateConfiguration()).toThrow(
        /MEMORY_EMBED_MODEL must reference an embedding model, got "gpt-4o"/,
      );
    });

    it('succeeds with valid configuration', () => {
      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      expect(() => client.validateConfiguration()).not.toThrow();
    });

    it('accepts model name with "embedding" in any case', () => {
      const client = new OpenAIEmbeddingClient(
        'test-key',
        'Text-Embedding-3-large',
      );
      expect(() => client.validateConfiguration()).not.toThrow();
    });
  });

  /* ---- embedMany --------------------------------------------------------- */

  describe('embedMany()', () => {
    function mockFetchOk(data: Array<{ embedding: number[] }>) {
      return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data }),
      } as Response);
    }

    it('sends correct request and returns embeddings', async () => {
      const vectors = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      const fetchSpy = mockFetchOk(vectors.map((v) => ({ embedding: v })));

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
        undefined,
        undefined,
        undefined,
        3,
      );
      const result = await client.embedMany(['hello', 'world']);

      expect(result).toEqual(vectors);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-key',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'text-embedding-test',
            input: ['hello', 'world'],
            dimensions: 3,
          }),
        }),
      );
    });

    it('resolves the API key lazily from brokered model access', async () => {
      const vectors = [[0.1, 0.2, 0.3]];
      const fetchSpy = mockFetchOk(vectors.map((v) => ({ embedding: v })));
      const resolveApiKey = vi.fn(async () => 'brokered-openai-key');

      const client = new OpenAIEmbeddingClient(
        resolveApiKey,
        'text-embedding-test',
        undefined,
        undefined,
        undefined,
        3,
      );
      const result = await client.embedMany(['hello']);

      expect(result).toEqual(vectors);
      expect(resolveApiKey).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer brokered-openai-key',
            'Content-Type': 'application/json',
          },
        }),
      );
    });

    it('routes brokered embeddings through a gateway base URL', async () => {
      const vectors = [[0.1, 0.2, 0.3]];
      const fetchSpy = mockFetchOk(vectors.map((v) => ({ embedding: v })));
      const resolveApiKey = vi.fn(async () => 'gtw_openai');
      const resolveBaseUrl = vi.fn(async () => 'http://127.0.0.1:8123/openai');

      const client = new OpenAIEmbeddingClient(
        resolveApiKey,
        'text-embedding-test',
        undefined,
        resolveBaseUrl,
        undefined,
        3,
      );
      const result = await client.embedMany(['hello']);

      expect(result).toEqual(vectors);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8123/openai/v1/embeddings',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer gtw_openai',
            'Content-Type': 'application/json',
          },
        }),
      );
    });

    it('uses one brokered gateway connection and revokes it after use', async () => {
      const vectors = [[0.1, 0.2, 0.3]];
      const fetchSpy = mockFetchOk(vectors.map((v) => ({ embedding: v })));
      const revoke = vi.fn(async () => undefined);
      const resolveConnection = vi.fn(async () => ({
        apiKey: 'gtw_openai_once',
        baseUrl: 'http://127.0.0.1:8123/openai',
        revoke,
      }));

      const client = new OpenAIEmbeddingClient(
        null,
        'text-embedding-test',
        undefined,
        'https://api.openai.com',
        resolveConnection,
        3,
      );
      const result = await client.embedMany(['hello']);

      expect(result).toEqual(vectors);
      expect(resolveConnection).toHaveBeenCalledOnce();
      expect(revoke).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8123/openai/v1/embeddings',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer gtw_openai_once',
            'Content-Type': 'application/json',
          },
        }),
      );
    });

    it('throws on non-ok HTTP response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
        headers: { get: () => null },
      } as unknown as Response);

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        /embedding provider rate limited \(429\): rate limited/,
      );
    });

    it('throws invalid_dimension when the returned vector length mismatches', async () => {
      mockFetchOk([{ embedding: [0.1, 0.2, 0.3, 0.4] }]);

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
        undefined,
        undefined,
        undefined,
        3,
      );
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        /returned 4 dimensions, but Gantry semantic memory is configured for 3/,
      );
    });

    it('throws on response size mismatch', async () => {
      // Request 2 texts but return only 1 embedding
      mockFetchOk([{ embedding: [0.1, 0.2] }]);

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      await expect(client.embedMany(['hello', 'world'])).rejects.toThrow(
        /embedding response size mismatch: expected 2, got 1/,
      );
    });

    it('throws when data field is missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: null }),
      } as Response);

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        /embedding response size mismatch/,
      );
    });

    it('throws on invalid embedding vector (empty array)', async () => {
      mockFetchOk([{ embedding: [] }]);

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        'embedding response contained invalid embedding vector',
      );
    });

    it('throws on invalid embedding vector (not an array)', async () => {
      mockFetchOk([{ embedding: 'not-an-array' as unknown as number[] }]);

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        'embedding response contained invalid embedding vector',
      );
    });

    it('batches requests according to MEMORY_EMBED_BATCH_SIZE', async () => {
      // Create enough texts to require multiple batches
      const textCount = MEMORY_EMBED_BATCH_SIZE + 3;
      const texts = Array.from({ length: textCount }, (_, i) => `text-${i}`);
      const expectedBatches = Math.ceil(textCount / MEMORY_EMBED_BATCH_SIZE);

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, init) => {
          const body = JSON.parse((init as RequestInit).body as string);
          const batchInput = body.input as string[];
          return {
            ok: true,
            json: async () => ({
              data: batchInput.map((_, idx) => ({
                embedding: [idx * 0.1, idx * 0.2],
              })),
            }),
          } as Response;
        });

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
        undefined,
        undefined,
        undefined,
        2,
      );
      const result = await client.embedMany(texts);

      expect(fetchSpy).toHaveBeenCalledTimes(expectedBatches);
      expect(result).toHaveLength(textCount);

      // Verify first batch size
      const firstCallBody = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(firstCallBody.input).toHaveLength(MEMORY_EMBED_BATCH_SIZE);

      // Verify second (remainder) batch size
      const secondCallBody = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
      );
      expect(secondCallBody.input).toHaveLength(3);
    });

    it('handles empty input array', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      const result = await client.embedMany([]);

      expect(result).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  /* ---- embedOne ---------------------------------------------------------- */

  describe('embedOne()', () => {
    it('delegates to embedMany and returns first result', async () => {
      const vector = [0.1, 0.2, 0.3, 0.4];
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: vector }] }),
      } as Response);

      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
        undefined,
        undefined,
        undefined,
        4,
      );
      const result = await client.embedOne('hello');

      expect(result).toEqual(vector);
    });

    it('throws when embedMany returns empty result', async () => {
      // This shouldn't happen in practice (embedMany validates sizes),
      // but tests the safety check at line 96-98.
      const client = new OpenAIEmbeddingClient(
        'test-key',
        'text-embedding-test',
      );
      vi.spyOn(client, 'embedMany').mockResolvedValue([]);

      await expect(client.embedOne('hello')).rejects.toThrow(
        'embedding response was empty',
      );
    });
  });
});
