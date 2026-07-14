import type { BrainService } from './brain-service.js';

export async function runBrainEmbeddingBackfill(input: {
  brain: BrainService;
  appId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await input.brain.backfillEmbeddings({
    appId: input.appId,
    limit: input.limit,
    signal: input.signal,
  });
  return `Brain embedding backfill complete: ${result.indexed} indexed, ${result.pending} pending, ${result.skipped} skipped.`;
}
