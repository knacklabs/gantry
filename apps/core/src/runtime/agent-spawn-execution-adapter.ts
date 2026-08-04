import { resolveAgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { AgentOutput, RunAgentOptions } from './agent-spawn-types.js';

type ExecutionAdapter = NonNullable<RunAgentOptions['executionAdapter']>;

export function resolveSpawnExecutionAdapter(
  executionProviderId: string,
  options: RunAgentOptions | undefined,
):
  | { ok: true; executionAdapter: ExecutionAdapter }
  | { ok: false; output: AgentOutput } {
  try {
    const executionAdapter = resolveAgentExecutionAdapter({
      executionProviderId,
      registry: options?.executionAdapters,
      fallback: options?.executionAdapter,
    }) as ExecutionAdapter;
    if (executionAdapter) return { ok: true, executionAdapter };
    return {
      ok: false,
      output: {
        status: 'error',
        result: null,
        error:
          'No LLM execution adapter configured. Runtime bootstrap must provide an AgentExecutionAdapterRegistry.',
      },
    };
  } catch (err) {
    return {
      ok: false,
      output: {
        status: 'error',
        result: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
