import type {
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import { resolveAgentToolRuntimeRules } from '../agents/agent-tool-runtime-rules.js';

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
  const allowedTools =
    input.allowedTools ??
    (await resolveAgentToolRuntimeRules({
      repository: input.tools,
      skillRepository: input.skills,
      appId: input.appId,
      agentId: input.agentId,
      errorSubject: 'Configured agent tool',
    }));
  const authorizedServerNames = mcpServerNamesFromToolRules(allowedTools);

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
    if (authorizedServerNames.size === 0) return [String(binding.serverId)];
    return authorizedServerNames.has(server.name)
      ? [String(binding.serverId)]
      : [];
  });
}
