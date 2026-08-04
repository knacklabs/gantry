import { log } from './logging.js';
export function logUsage(message) {
    const resultMsg = message;
    if (resultMsg.modelUsage) {
        for (const [model, usage] of Object.entries(resultMsg.modelUsage)) {
            const cacheRead = usage.cacheReadInputTokens || 0;
            const cacheWrite = usage.cacheCreationInputTokens || 0;
            const totalInput = usage.inputTokens || 0;
            const cacheHitPct = totalInput > 0 ? ((cacheRead / totalInput) * 100).toFixed(1) : '0.0';
            log(`Usage [${model}]: input=${totalInput} output=${usage.outputTokens || 0} ` +
                `cacheRead=${cacheRead} cacheWrite=${cacheWrite} ` +
                `cacheHit=${cacheHitPct}% cost=$${(usage.costUSD || 0).toFixed(4)}`);
        }
    }
    if (resultMsg.total_cost_usd !== undefined) {
        log(`Total: cost=$${resultMsg.total_cost_usd.toFixed(4)} ` +
            `turns=${resultMsg.num_turns || 0} ` +
            `duration=${resultMsg.duration_ms || 0}ms ` +
            `apiTime=${resultMsg.duration_api_ms || 0}ms`);
    }
}
