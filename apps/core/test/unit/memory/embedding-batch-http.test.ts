import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchEmbeddingBatchResults,
  pollEmbeddingBatch,
  submitEmbeddingBatch,
} from '@core/memory/embedding-batch-http.js';

const conn = { apiKey: 'k', baseUrl: 'https://api.test' };

function res(
  body: unknown,
  opts: { ok?: boolean; status?: number; text?: string } = {},
): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
    text: async () => opts.text ?? JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('embedding batch http transport', () => {
  it('uploads a file then creates a batch and returns the batch id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) => {
        if (String(url).endsWith('/v1/files')) return res({ id: 'file_1' });
        if (String(url).endsWith('/v1/batches')) return res({ id: 'batch_1' });
        throw new Error(`unexpected url ${url}`);
      });
    const out = await submitEmbeddingBatch(conn, {
      model: 'm',
      dimensions: 1536,
      requests: [{ customId: 'i1', input: 't1' }],
    });
    expect(out.batchId).toBe('batch_1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws a classified provider_quota error when the file upload 402s', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      res({}, { ok: false, status: 402, text: 'no funds' }),
    );
    await expect(
      submitEmbeddingBatch(conn, {
        model: 'm',
        dimensions: 1536,
        requests: [{ customId: 'i1', input: 't' }],
      }),
    ).rejects.toMatchObject({ code: 'provider_quota' });
  });

  it('maps batch status to a normalized state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      res({
        status: 'completed',
        output_file_id: 'out_1',
        error_file_id: null,
      }),
    );
    const poll = await pollEmbeddingBatch(conn, 'batch_1');
    expect(poll.state).toBe('completed');
    expect(poll.outputFileId).toBe('out_1');
  });

  it('parses output rows to embeddings and error rows to error strings', async () => {
    const outputJsonl = JSON.stringify({
      custom_id: 'i1',
      response: { body: { data: [{ embedding: [0.1, 0.2] }] } },
    });
    const errorJsonl = JSON.stringify({
      custom_id: 'i2',
      error: { message: 'bad input' },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('out_1'))
        return res(null, { text: outputJsonl });
      if (String(url).includes('err_1')) return res(null, { text: errorJsonl });
      throw new Error(`unexpected url ${url}`);
    });
    const rows = await fetchEmbeddingBatchResults(conn, {
      batchId: 'b',
      state: 'completed',
      outputFileId: 'out_1',
      errorFileId: 'err_1',
      error: null,
    });
    expect(rows).toContainEqual({ customId: 'i1', embedding: [0.1, 0.2] });
    expect(rows.find((r) => r.customId === 'i2')?.error).toBeTruthy();
  });
});
