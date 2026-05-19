import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';

export function resolveRuntimeExecutionProviderId(
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>,
): ExecutionProviderId {
  return (executionAdapter?.id ??
    'unconfigured:agent-execution-adapter') as ExecutionProviderId;
}
