import { findModelByRunnerModel } from '../../shared/model-catalog.js';
import { resolveModelCacheProvider } from '../../shared/model-cache-support.js';
import { estimateUsageCostUsd } from '../../shared/model-usage.js';

const CHAT_BATCH_UPLOAD_LIMIT_BYTES = 14 * 1024 * 1024;
export const CHAT_BATCH_RESULT_LIMIT_BYTES = 64 * 1024 * 1024;
export const CHAT_BATCH_RESULT_LIMIT_ROWS = 100_000;
const CHAT_BATCH_PRICE_MULTIPLIER = 0.5;

export interface ChatBatchJsonlBudget {
  bytesRead: number;
  rowsRead: number;
}

export function assertChatBatchUploadSize(
  body: string,
  provider: string,
): void {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > CHAT_BATCH_UPLOAD_LIMIT_BYTES) {
    throw new Error(
      `${provider} batch upload is ${bytes} bytes; the limit is ${CHAT_BATCH_UPLOAD_LIMIT_BYTES} bytes.`,
    );
  }
}

export async function fetchBatchJson<T>(input: {
  provider: string;
  operation: string;
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await fetch(input.url, {
    ...input.init,
    signal: input.signal,
  });
  await assertBatchHttpOk(response, input.provider, input.operation);
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(
      `${input.provider} batch ${input.operation} returned invalid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function fetchBatchJsonl(input: {
  provider: string;
  operation: string;
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  maxBytes?: number;
  maxRows?: number;
  budget?: ChatBatchJsonlBudget;
}): Promise<unknown[]> {
  const response = await fetch(input.url, {
    ...input.init,
    signal: input.signal,
  });
  await assertBatchHttpOk(response, input.provider, input.operation);
  if (!response.body) {
    throw new Error(`${input.provider} batch ${input.operation} had no body.`);
  }
  const maxBytes = input.maxBytes ?? CHAT_BATCH_RESULT_LIMIT_BYTES;
  const maxRows = input.maxRows ?? CHAT_BATCH_RESULT_LIMIT_ROWS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Chat batch result byte limit must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new Error('Chat batch result row limit must be a positive integer.');
  }
  const rows: unknown[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const budget = input.budget ?? { bytesRead: 0, rowsRead: 0 };
  let pending = '';
  let lineNumber = 0;
  const parseLine = (line: string): void => {
    lineNumber += 1;
    if (!line.trim()) return;
    if (budget.rowsRead >= maxRows) {
      throw new Error(
        `${input.provider} batch result exceeded the ${maxRows} row limit.`,
      );
    }
    try {
      rows.push(JSON.parse(line) as unknown);
      budget.rowsRead += 1;
    } catch (error) {
      throw new Error(
        `${input.provider} batch result JSONL line ${lineNumber} is invalid: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    budget.bytesRead += value.byteLength;
    if (budget.bytesRead > maxBytes) {
      await reader.cancel();
      throw new Error(
        `${input.provider} batch result exceeded the ${maxBytes} byte limit.`,
      );
    }
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      parseLine(line);
      newline = pending.indexOf('\n');
    }
  }
  pending += decoder.decode();
  if (pending) parseLine(pending.replace(/\r$/, ''));
  return rows;
}

export function estimateChatBatchCostUsd(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): number | null {
  const entry = findModelByRunnerModel(model);
  const estimated = estimateUsageCostUsd(entry, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheProvider: resolveModelCacheProvider(entry),
  });
  return estimated === undefined
    ? null
    : estimated * CHAT_BATCH_PRICE_MULTIPLIER;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

async function assertBatchHttpOk(
  response: Response,
  provider: string,
  operation: string,
): Promise<void> {
  if (response.ok) return;
  const detail = (await response.text()).slice(0, 300);
  throw new Error(
    `${provider} batch ${operation} failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
