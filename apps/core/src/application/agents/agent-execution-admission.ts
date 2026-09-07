import type { AgentId } from '../../domain/agent/agent.js';
import type { AgentRepository } from '../../domain/ports/repositories.js';

export const OFFBOARDED_AGENT_EXECUTION_ERROR =
  'This AI employee is offboarded and cannot start another tool call.';

export async function executionAdmissionForAgent(input: {
  agentId?: string;
  getAgentRepository: () => Pick<AgentRepository, 'getAgent'> | undefined;
}): Promise<string | undefined> {
  const repository = input.getAgentRepository();
  if (!input.agentId || !repository) return undefined;
  const agent = await repository.getAgent(input.agentId as AgentId);
  return agent?.status === 'offboarded'
    ? OFFBOARDED_AGENT_EXECUTION_ERROR
    : undefined;
}
