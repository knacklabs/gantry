import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';

export function resolveRuntimeExecutionProviderId(
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>,
): ExecutionProviderId {
  const id = executionAdapter?.id?.trim();
  if (!id) {
    throw new Error('Runtime execution adapter is not configured.');
  }
  return id as ExecutionProviderId;
}

export function resolveConfiguredRuntimeExecutionProviderId(input: {
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
  executionAdapters?: Pick<AgentExecutionAdapterRegistry, 'list'>;
}): ExecutionProviderId {
  const executionAdapter =
    input.executionAdapter ?? input.executionAdapters?.list()[0];
  if (executionAdapter)
    return resolveRuntimeExecutionProviderId(executionAdapter);
  return resolveRuntimeExecutionProviderId();
}
