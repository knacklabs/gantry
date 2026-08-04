import { nowIso } from '../../../../shared/time/datetime.js';
import { log } from './logging.js';
export async function readContextUsage(queryHandle) {
    const candidate = queryHandle;
    if (typeof candidate.getContextUsage !== 'function')
        return undefined;
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
        };
    }
    catch (err) {
        log(`Context usage unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}
