import { log } from './logging.js';

export function logUsage(message: unknown): void {
  const resultMsg = message as {
    total_cost_usd?: number;
    num_turns?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
      }
    >;
  };
  if (resultMsg.modelUsage) {
    for (const [model, usage] of Object.entries(resultMsg.modelUsage)) {
      const cacheRead = usage.cacheReadInputTokens || 0;
      const cacheWrite = usage.cacheCreationInputTokens || 0;
      const totalInput = usage.inputTokens || 0;
      const cacheHitPct =
        totalInput > 0 ? ((cacheRead / totalInput) * 100).toFixed(1) : '0.0';
      log(
        `Usage [${model}]: input=${totalInput} output=${usage.outputTokens || 0} ` +
          `cacheRead=${cacheRead} cacheWrite=${cacheWrite} ` +
          `cacheHit=${cacheHitPct}% cost=$${(usage.costUSD || 0).toFixed(4)}`,
      );
    }
  }
  if (resultMsg.total_cost_usd !== undefined) {
    log(
      `Total: cost=$${resultMsg.total_cost_usd.toFixed(4)} ` +
        `turns=${resultMsg.num_turns || 0} ` +
        `duration=${resultMsg.duration_ms || 0}ms ` +
        `apiTime=${resultMsg.duration_api_ms || 0}ms`,
    );
  }
}
