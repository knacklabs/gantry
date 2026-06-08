import {
  EmbeddingProviderError,
  classifyEmbeddingHttpError,
} from './memory-embedding-errors.js';
import type {
  EmbeddingBatchPoll,
  EmbeddingBatchRequest,
  EmbeddingBatchResultRow,
  EmbeddingBatchState,
} from './memory-embeddings.js';

interface Connection {
  apiKey: string;
  baseUrl: string;
}

/**
 * HTTP transport for the brokered embedding provider's async Batch API
 * (`/v1/files` + `/v1/batches`, results downloaded from `/v1/files/{id}/content`).
 * The provider is resolved/brokered by the caller; this module is transport-only.
 */
function mapBatchState(status: string | undefined): EmbeddingBatchState {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

/** Upload a JSONL batch file and create an async embeddings batch. */
export async function submitEmbeddingBatch(
  conn: Connection,
  params: {
    model: string;
    dimensions: number;
    requests: EmbeddingBatchRequest[];
  },
  signal?: AbortSignal,
): Promise<{ batchId: string }> {
  const jsonl = params.requests
    .map((request) =>
      JSON.stringify({
        custom_id: request.customId,
        method: 'POST',
        url: '/v1/embeddings',
        body: {
          model: params.model,
          input: request.input,
          dimensions: params.dimensions,
        },
      }),
    )
    .join('\n');
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append(
    'file',
    new Blob([jsonl], { type: 'application/jsonl' }),
    'memory-embeddings.jsonl',
  );
  const fileRes = await fetch(`${conn.baseUrl}/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.apiKey}` },
    body: form,
    signal,
  });
  if (!fileRes.ok) {
    throw classifyEmbeddingHttpError(
      fileRes.status,
      await fileRes.text(),
      fileRes.headers,
    );
  }
  const fileJson = (await fileRes.json()) as { id?: string };
  if (!fileJson.id) {
    throw new EmbeddingProviderError(
      'retryable_provider_error',
      'batch input file upload returned no id',
    );
  }
  const batchRes = await fetch(`${conn.baseUrl}/v1/batches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${conn.apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify({
      input_file_id: fileJson.id,
      endpoint: '/v1/embeddings',
      completion_window: '24h',
    }),
  });
  if (!batchRes.ok) {
    throw classifyEmbeddingHttpError(
      batchRes.status,
      await batchRes.text(),
      batchRes.headers,
    );
  }
  const batchJson = (await batchRes.json()) as { id?: string };
  if (!batchJson.id) {
    throw new EmbeddingProviderError(
      'retryable_provider_error',
      'batch creation returned no id',
    );
  }
  return { batchId: batchJson.id };
}

export async function pollEmbeddingBatch(
  conn: Connection,
  batchId: string,
  signal?: AbortSignal,
): Promise<EmbeddingBatchPoll> {
  const res = await fetch(`${conn.baseUrl}/v1/batches/${batchId}`, {
    headers: { Authorization: `Bearer ${conn.apiKey}` },
    signal,
  });
  if (!res.ok) {
    throw classifyEmbeddingHttpError(res.status, await res.text(), res.headers);
  }
  const json = (await res.json()) as {
    status?: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
    errors?: unknown;
  };
  return {
    batchId,
    state: mapBatchState(json.status),
    outputFileId: json.output_file_id ?? null,
    errorFileId: json.error_file_id ?? null,
    error: json.errors ? JSON.stringify(json.errors).slice(0, 300) : null,
  };
}

export async function fetchEmbeddingBatchResults(
  conn: Connection,
  poll: EmbeddingBatchPoll,
  signal?: AbortSignal,
): Promise<EmbeddingBatchResultRow[]> {
  const rows: EmbeddingBatchResultRow[] = [];
  if (poll.outputFileId) {
    const text = await downloadFile(conn, poll.outputFileId, signal);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as {
        custom_id?: string;
        response?: { body?: { data?: Array<{ embedding?: number[] }> } };
        error?: unknown;
      };
      if (!obj.custom_id) continue;
      const embedding = obj.response?.body?.data?.[0]?.embedding;
      if (Array.isArray(embedding)) {
        rows.push({ customId: obj.custom_id, embedding });
      } else {
        rows.push({
          customId: obj.custom_id,
          error: obj.error
            ? JSON.stringify(obj.error).slice(0, 300)
            : 'batch output contained no embedding',
        });
      }
    }
  }
  if (poll.errorFileId) {
    const text = await downloadFile(conn, poll.errorFileId, signal);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as { custom_id?: string; error?: unknown };
      if (!obj.custom_id) continue;
      rows.push({
        customId: obj.custom_id,
        error: JSON.stringify(obj.error ?? {}).slice(0, 300),
      });
    }
  }
  return rows;
}

async function downloadFile(
  conn: Connection,
  fileId: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${conn.baseUrl}/v1/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${conn.apiKey}` },
    signal,
  });
  if (!res.ok) {
    throw classifyEmbeddingHttpError(res.status, await res.text(), res.headers);
  }
  return res.text();
}
