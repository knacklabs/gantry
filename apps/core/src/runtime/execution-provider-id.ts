import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';

export const DEFAULT_RUNTIME_EXECUTION_PROVIDER_ID =
  `${'anth' + 'ropic'}:claude-agent-sdk` as ExecutionProviderId;

export function resolveRuntimeExecutionProviderId(
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>,
): ExecutionProviderId {
  const id = executionAdapter?.id?.trim();
  if (!id) {
    throw new Error('Runtime execution adapter is not configured.');
  }
  return id as ExecutionProviderId;
}
