import * as p from '@clack/prompts';

import { DEFAULT_MEMORY_APP_ID } from '../memory/app-memory-boundaries.js';
import {
  runEmbeddingBackfill,
  type BackfillResult,
} from '../memory/app-memory-backfill.js';
import { createEmbeddingProvider } from '../memory/memory-embeddings.js';
import { EmbeddingProviderError } from '../memory/memory-embedding-errors.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import type { AppId } from '../domain/app/app.js';
import type { MemoryBackfillMode } from '../config/settings/runtime-settings-types.js';

interface ParsedFlags {
  limit?: number;
  mode?: MemoryBackfillMode;
  error?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const result: ParsedFlags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--limit') {
      const value = Number(args[(i += 1)]);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: '--limit must be a positive integer' };
      }
      result.limit = value;
    } else if (arg === '--mode') {
      const value = args[(i += 1)];
      if (
        value !== 'auto' &&
        value !== 'inline' &&
        value !== 'provider_batch'
      ) {
        return {
          error: '--mode must be one of auto, inline, or provider_batch',
        };
      }
      result.mode = value;
    } else {
      return { error: `unknown flag "${arg}"` };
    }
  }
  return result;
}

function fmt(count: number): string {
  return count.toLocaleString('en-US');
}

function reportResult(result: BackfillResult): number {
  if (result.pausedByPriorRun) {
    p.log.warn(pausedMessage(result));
    return 0;
  }
  if (result.alreadyRunning) {
    p.log.warn(
      'Memory embedding backfill skipped: another run is already in progress.',
    );
    return 0;
  }
  if (result.mode === 'provider_batch' && result.submitted > 0) {
    p.log.success(
      `Memory embedding batch submitted: ${fmt(result.submitted)} items queued. Status will update from scheduled polling. Run \`gantry memory status\` (or /memory-status) to track ready/pending counts.`,
    );
    return 0;
  }
  if (result.status === 'failed') {
    p.log.error(
      `Memory embedding backfill failed: ${result.errorMessage ?? 'storage failure'}`,
    );
    return 1;
  }
  if (result.status === 'paused') {
    p.log.warn(pausedMessage(result));
    return 0;
  }
  p.log.success(
    `Memory embedding backfill complete: ${fmt(result.indexed)} indexed, ${fmt(result.pending)} pending.`,
  );
  return 0;
}

function pausedMessage(result: BackfillResult): string {
  const indexed = fmt(result.indexed);
  switch (result.pauseReason) {
    case 'paused_daily_budget':
      return `Memory embedding backfill paused: daily embedding budget reached after ${indexed} indexed. It will resume tomorrow or when the limit is raised.`;
    case 'paused_provider_quota':
      return `Memory embedding backfill paused: provider quota unavailable after ${indexed} indexed. It will resume from remaining items on the next run.`;
    case 'paused_rate_limit':
      return `Memory embedding backfill paused: provider rate limit reached after ${indexed} indexed. It will resume from remaining items on the next run.`;
    default:
      return `Memory embedding backfill paused: provider error after ${indexed} indexed. It will resume from remaining items on the next run.`;
  }
}

export async function runEmbeddingBackfillCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const flags = parseFlags(args);
  if (flags.error) {
    p.log.error(`Memory embedding backfill failed: ${flags.error}`);
    return 1;
  }

  const settings = loadRuntimeSettings(runtimeHome);
  const embeddings = settings.memory.embeddings;
  if (!embeddings.enabled || embeddings.provider === 'disabled') {
    p.log.error(
      'Memory embedding backfill failed: embeddings are not enabled. Run `gantry memory embeddings openai` first.',
    );
    return 1;
  }

  process.env.GANTRY_HOME = runtimeHome;
  const { initializeRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  const storage = await initializeRuntimeStorage();
  try {
    const provider = createEmbeddingProvider(embeddings.provider, {
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      appId: DEFAULT_MEMORY_APP_ID as AppId,
    });
    const result = await runEmbeddingBackfill({
      db: storage.service.db,
      appId: DEFAULT_MEMORY_APP_ID,
      trigger: 'cli',
      provider: embeddings.provider,
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      batchSize: embeddings.batchSize,
      dailyLimit: embeddings.dailyLimit,
      maxItemsPerRun: embeddings.backfill.maxItemsPerRun,
      providerBatchMinItems: embeddings.backfill.providerBatchMinItems,
      mode: flags.mode ?? embeddings.backfill.mode,
      ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      embeddingProvider: provider,
    });
    return reportResult(result);
  } catch (error) {
    if (error instanceof EmbeddingProviderError) {
      p.log.error(`Memory embedding backfill failed: ${error.message}`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(`Memory embedding backfill failed: ${message}`);
    return 1;
  } finally {
    await storage.runtimeEventNotifier.close().catch(() => {});
    await storage.service.close().catch(() => {});
  }
}
