import type {
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
const MCP_TOOL_RULE_PATTERN = /^mcp__([a-z][a-z0-9_-]{0,62})__/;

export function mcpServerNamesFromToolRules(
  rules: readonly string[] | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const rule of rules ?? []) {
    const match = MCP_TOOL_RULE_PATTERN.exec(rule.trim());
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export async function authorizedMcpServerIdsForAgent(input: {
  mcpServers: McpServerRepository;
  tools: ToolCatalogRepository;
  skills?: SkillCatalogRepository;
  appId: string;
  agentId: string;
  allowedTools?: readonly string[];
}): Promise<string[]> {
  // An MCP server is authorized for an agent when the agent has an ACTIVE
  // binding to it. Bindings are created only through approved flows — an
  // operator-declared `sources.mcp_servers` entry reconciled from authoritative
  // settings, or an approved `request_mcp_server` — so the binding itself is the
  // durable grant (a sourced MCP server behaves like a sourced skill, which is
  // usable without an extra per-tool capability). Which tools may actually run
  // is still gated downstream by the server version's allowed_tool_patterns and
  // the per-call approval / auto-approve policy in the MCP proxy.
  const bindings = await input.mcpServers.listAgentBindings({
    appId: input.appId as never,
    agentId: input.agentId as never,
    limit: 500,
  });
  const activeBindings = bindings.filter(
    (binding) => binding.status === 'active',
  );
  const servers = await Promise.all(
    activeBindings.map((binding) =>
      input.mcpServers.getServer(binding.serverId),
    ),
  );
  return activeBindings.flatMap((binding, index) => {
    const server = servers[index];
    if (!server || server.appId !== input.appId) return [];
    return [String(binding.serverId)];
  });
}
