import type { ConversationRoute } from '../domain/types.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import type { AgentInput } from './agent-spawn-types.js';

export function resolveSpawnAgentId(input: {
  inputAgentId?: string;
  routeAgentId?: string;
  workspaceFolder: string;
}): string {
  return (
    input.inputAgentId ??
    input.routeAgentId ??
    memoryAgentIdForWorkspaceFolder(input.workspaceFolder)
  );
}

export function resolveAgentSpawnLogContext(
  group: ConversationRoute,
  input: AgentInput,
  correlationRunId?: string,
) {
  const appId = input.appId ?? 'default';
  const agentId = resolveSpawnAgentId({
    inputAgentId: input.agentId,
    routeAgentId: group.agentId,
    workspaceFolder: group.folder,
  });
  return {
    agentName: group.name,
    turn: { ...input, appId, agentId },
    correlationRunId: input.runId ?? correlationRunId,
    appId,
    agentId,
  };
}

export function stripIncompleteRunLeaseIdentity(input: AgentInput): AgentInput {
  const hasRunId = Boolean(input.runId);
  const hasLeaseToken = Boolean(input.runLeaseToken);
  const hasFencingVersion = typeof input.runLeaseFencingVersion === 'number';
  if (hasRunId && hasLeaseToken && hasFencingVersion) return input;
  if (!hasRunId && !hasLeaseToken && !hasFencingVersion) return input;

  const {
    runId: _runId,
    runLeaseToken: _runLeaseToken,
    runLeaseFencingVersion: _runLeaseFencingVersion,
    ...correlationOnlyInput
  } = input;
  return correlationOnlyInput;
}
