import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';

type CompactionPromptAdapter = Pick<
  AgentExecutionAdapter,
  'id' | 'sessionCompactionPrompt'
>;

export function maintenanceCompactionPromptForExecutionProvider(
  executionProviderId: string,
  input: {
    executionAdapter?: CompactionPromptAdapter;
    executionAdapters?: AgentExecutionAdapterRegistry;
  },
): string | undefined {
  const adapter =
    input.executionAdapters?.get(executionProviderId) ??
    (input.executionAdapter?.id === executionProviderId
      ? input.executionAdapter
      : undefined);
  return adapter?.sessionCompactionPrompt?.();
}
