import { ApplicationError } from '../common/application-error.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type {
  AgentMcpServerBinding,
  McpServerDefinition,
  McpServerId,
} from '../../domain/mcp/mcp-servers.js';
import {
  normalizeMcpToolScope,
  reviewedMcpToolPatterns,
} from '../../shared/mcp-tool-scope.js';

export function nextMcpSourceBindings(input: {
  appId: AppId;
  agentId: AgentId;
  sources: Array<{ id: string; tools?: string[] }>;
  servers: ReadonlyMap<McpServerId, McpServerDefinition>;
  existingBindings: AgentMcpServerBinding[];
  now: string;
}): AgentMcpServerBinding[] {
  const existingByServerId = new Map(
    input.existingBindings.map((binding) => [binding.serverId, binding]),
  );
  const sourceByServerId = new Map(
    input.sources.map((source) => [source.id as McpServerId, source]),
  );
  return [...sourceByServerId.entries()].map(([serverId, source]) => {
    const existing = existingByServerId.get(serverId);
    const server = input.servers.get(serverId);
    if (!server) {
      throw new ApplicationError(
        'NOT_FOUND',
        `MCP server not found: ${serverId}`,
      );
    }
    return {
      id: `agent-mcp-binding:${input.agentId}:${serverId}` as AgentMcpServerBinding['id'],
      appId: input.appId,
      agentId: input.agentId,
      serverId,
      status: 'active',
      required: existing?.required ?? false,
      permissionPolicyIds: existing?.permissionPolicyIds ?? [],
      allowedToolPatterns: normalizeMcpToolScope({
        serverName: server.name,
        requested: source.tools ?? [],
        definitionPatterns: reviewedMcpToolPatterns(server),
      }),
      conversationId: existing?.conversationId,
      threadId: existing?.threadId,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
  });
}
