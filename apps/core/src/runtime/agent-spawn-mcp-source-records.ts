import {
  assertHostAccessSnapshot,
  type AgentAccessSnapshot,
} from '../application/agent-execution/agent-access-snapshot.js';
import type { MaterializedMcpServer } from '../domain/mcp/mcp-servers.js';
import type { RunAgentOptions } from './agent-spawn-types.js';

export function accessSnapshotForSpawnMcpProjection(
  options: RunAgentOptions | undefined,
): AgentAccessSnapshot | undefined {
  if (
    !options?.accessSnapshot ||
    !options.mcpContext?.appId ||
    !options.mcpContext.agentId
  ) {
    return undefined;
  }
  return assertHostAccessSnapshot({
    accessSnapshot: options.accessSnapshot,
    appId: options.mcpContext.appId,
    agentId: options.mcpContext.agentId,
    subject: 'Spawn MCP projection',
  });
}

export async function resolveSpawnMcpSourceRecords(input: {
  attachedMcpSourceIds: readonly string[];
  options: RunAgentOptions | undefined;
  accessSnapshot: AgentAccessSnapshot | undefined;
}): Promise<MaterializedMcpServer[]> {
  const snapshotRecords = input.accessSnapshot?.mcp.materializedServers;
  if (snapshotRecords) {
    const attachedMcpSourceIds = new Set(input.attachedMcpSourceIds);
    return snapshotRecords.filter((record) =>
      attachedMcpSourceIds.has(String(record.definition.id)),
    );
  }
  const options = input.options;
  if (
    !options?.mcpServerRepository ||
    !options.mcpContext?.appId ||
    !options.mcpContext.agentId ||
    input.attachedMcpSourceIds.length === 0
  ) {
    return [];
  }
  return options.mcpServerRepository.listMaterializedServersForAgent({
    appId: options.mcpContext.appId as never,
    agentId: options.mcpContext.agentId as never,
    serverIds: input.attachedMcpSourceIds as never,
  });
}
