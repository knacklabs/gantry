import type { RuntimeContextUsageSnapshot } from '../../../../shared/model-catalog.js';
import { log } from './logging.js';
import type { AgentRunnerOutput } from './types.js';

/**
 * Emits the post-result context-usage snapshot WITHOUT blocking the reply.
 *
 * `getContextUsage()` round-trips the CLI subprocess and was measured at
 * 0.7-4.1s per turn — awaiting it before writing the result envelope held the
 * customer-visible reply for that long (RC4 in the latency diagnosis), even
 * though its only consumers are status/diagnostics. The emitter writes a
 * follow-up `result: null` envelope when the fetch settles; core's envelope
 * handler already treats `contextUsage` independently of the reply.
 *
 * Fetches are serialized (one CLI RPC at a time) and `flush()` is bounded so
 * runner shutdown is never stalled by a hung CLI.
 */
export function createDeferredContextUsageEmitter(input: {
  readUsage: () => Promise<RuntimeContextUsageSnapshot | undefined>;
  write: (output: AgentRunnerOutput) => void;
  getSessionId: () => string | undefined;
}): {
  emitAfterResult: () => void;
  flush: (timeoutMs: number) => Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();
  return {
    emitAfterResult(): void {
      chain = chain.then(async () => {
        try {
          const contextUsage = await input.readUsage();
          if (!contextUsage) return;
          input.write({
            status: 'success',
            result: null,
            newSessionId: input.getSessionId(),
            contextUsage,
          });
          // eslint-disable-next-line no-catch-all/no-catch-all -- diagnostics-only emission must never break the run; failures are logged.
        } catch (err) {
          log(
            `Deferred context usage emission failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    },
    flush(timeoutMs: number): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      return Promise.race([chain, bound]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    },
  };
}
