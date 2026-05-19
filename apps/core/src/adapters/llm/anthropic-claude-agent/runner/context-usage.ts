import type { RuntimeContextUsageSnapshot } from '../../../../shared/model-catalog.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import { log } from './logging.js';

export async function readContextUsage(queryHandle: unknown) {
  const candidate = queryHandle as {
    getContextUsage?: () => Promise<{
      totalTokens: number;
      maxTokens: number;
      percentage: number;
      model?: string;
      categories?: Array<{
        name: string;
        tokens: number;
        percentage?: number;
      }>;
      apiUsage?: RuntimeContextUsageSnapshot['apiUsage'];
    }>;
  };
  if (typeof candidate.getContextUsage !== 'function') return undefined;
  try {
    const usage = await candidate.getContextUsage();
    return {
      totalTokens: usage.totalTokens,
      maxTokens: usage.maxTokens,
      percentage: usage.percentage,
      model: usage.model,
      categories: (usage.categories ?? []).map((category) => ({
        name: category.name,
        tokens: category.tokens,
        percentage: category.percentage,
      })),
      apiUsage: usage.apiUsage,
      at: nowIso(),
    } satisfies RuntimeContextUsageSnapshot;
  } catch (err) {
    log(
      `Context usage unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
