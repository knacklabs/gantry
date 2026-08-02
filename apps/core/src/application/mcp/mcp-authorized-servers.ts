import type { McpServerRepository } from '../../domain/ports/repositories.js';
import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type { AgentMcpAccessSnapshot } from '../../domain/ports/repositories.js';

const MAX_AUTHORIZED_MCP_BINDINGS = 500;
const MCP_SERVER_LOOKUP_CONCURRENCY = 10;

// Discovery is not authorization: every ACTIVE bound MCP server is a projected
// source (inventory-only connects included), regardless of which mcp__ tool
// rules are selected. Action stays capability-gated at call time by the
// reviewed pattern/name checks in mcp-tool-authorization.
export async function authorizedMcpServerIdsForAgent(input: {
  mcpServers: McpServerRepository;
  appId: string;
  agentId: string;
  conversationId?: string;
  threadId?: string;
}): Promise<string[]> {
  const bindings = await input.mcpServers.listAgentBindings({
    appId: input.appId as never,
    agentId: input.agentId as never,
  });
  const activeBindings = bindings
    .filter(
      (binding) =>
        binding.status === 'active' &&
        mcpBindingMatchesRouteScope(binding, input),
    )
    .slice(0, MAX_AUTHORIZED_MCP_BINDINGS);
  const servers: Array<Awaited<ReturnType<McpServerRepository['getServer']>>> =
    [];
  for (
    let offset = 0;
    offset < activeBindings.length;
    offset += MCP_SERVER_LOOKUP_CONCURRENCY
  ) {
    servers.push(
      ...(await Promise.all(
        activeBindings
          .slice(offset, offset + MCP_SERVER_LOOKUP_CONCURRENCY)
          .map((binding) => input.mcpServers.getServer(binding.serverId)),
      )),
    );
  }
  return activeBindings.flatMap((binding, index) => {
    const server = servers[index];
    if (!server || server.appId !== input.appId) return [];
    return [String(binding.serverId)];
  });
}

export function mcpBindingMatchesRouteScope(
  binding: Pick<AgentMcpServerBinding, 'conversationId' | 'threadId'>,
  scope: { conversationId?: string; threadId?: string },
): boolean {
  if (binding.threadId !== undefined && binding.conversationId === undefined) {
    return false;
  }
  if (
    binding.conversationId !== undefined &&
    binding.conversationId !== scope.conversationId
  ) {
    return false;
  }
  return binding.threadId === undefined || binding.threadId === scope.threadId;
}

export function authorizedMcpServerIdsFromSnapshot(input: {
  appId: string;
  activeRows: AgentMcpAccessSnapshot['activeBindings'];
  conversationId?: string;
  threadId?: string;
}): string[] {
  return input.activeRows.flatMap((row) => {
    const binding = row.binding;
    if (binding.status !== 'active') return [];
    if (!mcpBindingMatchesRouteScope(binding, input)) return [];
    const server = row.definition;
    if (!server || server.appId !== input.appId) return [];
    return [String(binding.serverId)];
  });
}
