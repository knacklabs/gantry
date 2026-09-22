import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerDefinition } from '../../domain/mcp/mcp-servers.js';
import type { ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { AgentToolBinding } from '../../domain/tools/tools.js';
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import { semanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';

// Derives a stable, valid semantic-capability id from an MCP server's own
// name. Server names are already constrained to lowercase letters, digits,
// underscore, and dash (assertValidMcpServerName), but the semantic
// capability id grammar additionally forbids repeated/leading/trailing
// separators, so this collapses any run of non-alphanumerics to one dash.
function capabilityIdForMcpServer(serverName: string): string {
  const sanitized = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `mcp.${sanitized || 'server'}`;
}

// Reviewed capability that grants exactly the tool patterns the server
// definition itself already declares (allowedToolPatterns) — nothing wider.
// Returns undefined when the server declares no patterns: the mcp_pattern
// binding schema requires at least one, and there is nothing safe to grant
// automatically until an admin names at least one tool.
export function synthesizeMcpServerCapability(
  server: Pick<McpServerDefinition, 'allowedToolPatterns' | 'displayName' | 'name' | 'riskClass'>,
): { capabilityId: string; definition: SemanticCapabilityDefinition } | undefined {
  const patterns = [...new Set(server.allowedToolPatterns ?? [])];
  if (patterns.length === 0) return undefined;
  const capabilityId = capabilityIdForMcpServer(server.name);
  const label = server.displayName ?? server.name;
  const risk: SemanticCapabilityDefinition['risk'] =
    server.riskClass === 'high'
      ? 'admin'
      : server.riskClass === 'medium'
        ? 'write'
        : 'read';
  return {
    capabilityId,
    definition: {
      capabilityId,
      version: '1',
      displayName: `${label} (MCP)`,
      category: 'mcp',
      risk,
      can: `Call the reviewed tools of the MCP source "${label}": ${patterns.join(', ')}.`,
      cannot:
        'Cannot call any tool outside these declared patterns, and cannot change the source configuration.',
      credentialSource: 'configured_access',
      implementationBindings: [
        {
          kind: 'mcp_pattern',
          mcpServer: server.name,
          mcpToolPatterns: patterns,
        },
      ],
    },
  };
}

async function resolveMcpServerCapabilityTool(input: {
  tools: ToolCatalogRepository;
  appId: AppId;
  server: McpServerDefinition;
  now: string;
}) {
  const synthesized = synthesizeMcpServerCapability(input.server);
  if (!synthesized) return undefined;
  const tool = await ensureAgentToolCatalogItem({
    repository: input.tools,
    appId: input.appId,
    reference: semanticCapabilityRule(synthesized.capabilityId),
    now: input.now,
    semanticCapabilityDefinitions: {
      [synthesized.capabilityId]: synthesized.definition,
    },
  });
  return tool;
}

// Grants the agent durable, reviewable execution authority for this MCP
// server's declared tools — additive: it never touches any other selected
// capability, skill, or source binding for the agent.
export async function grantMcpServerCapability(input: {
  tools: ToolCatalogRepository;
  appId: AppId;
  agentId: AgentId;
  server: McpServerDefinition;
  now: string;
}): Promise<void> {
  const tool = await resolveMcpServerCapabilityTool(input);
  if (!tool) return;
  const existing = await input.tools.listAgentToolBindings({
    appId: input.appId,
    agentId: input.agentId,
  });
  const priorBinding = existing.find((binding) => binding.toolId === tool.id);
  if (priorBinding?.status === 'active') return;
  const binding: AgentToolBinding = {
    id: `agent-tool-binding:${input.agentId}:${tool.id}` as AgentToolBinding['id'],
    appId: input.appId,
    agentId: input.agentId,
    toolId: tool.id,
    status: 'active',
    createdAt: priorBinding?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  await input.tools.saveAgentToolBinding(binding);
}

// Revokes the durable capability grant this MCP server's attachment
// created, leaving any other capability grant for the agent untouched.
export async function revokeMcpServerCapability(input: {
  tools: ToolCatalogRepository;
  appId: AppId;
  agentId: AgentId;
  server: McpServerDefinition;
  now: string;
}): Promise<void> {
  const tool = await resolveMcpServerCapabilityTool(input);
  if (!tool) return;
  await input.tools.disableAgentToolBinding({
    appId: input.appId,
    agentId: input.agentId,
    toolId: tool.id,
    updatedAt: input.now,
  });
}
