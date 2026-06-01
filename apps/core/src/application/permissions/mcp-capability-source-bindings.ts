import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';

export async function ensureMcpSourceBindingsForRules(input: {
  appId: AppId;
  agentId: AgentId;
  mcpServerRepository?: McpServerRepository;
  rules: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  timestamp: string;
}): Promise<AgentMcpServerBinding[]> {
  const serverNames = mcpServerNamesForRules({
    rules: input.rules,
    semanticCapabilityDefinitions: input.semanticCapabilityDefinitions,
  });
  if (serverNames.length === 0 || !input.mcpServerRepository) return [];
  const existingBindings = await input.mcpServerRepository.listAgentBindings({
    appId: input.appId,
    agentId: input.agentId,
    limit: 500,
  });
  const existingByServerId = new Map(
    existingBindings.map((binding) => [binding.serverId, binding]),
  );
  const activated: AgentMcpServerBinding[] = [];
  for (const serverName of serverNames) {
    const server = await input.mcpServerRepository.getServerByName({
      appId: input.appId,
      name: serverName,
    });
    if (!server || server.status !== 'active') {
      throw new Error(
        `MCP source ${serverName} is not active for persistent MCP capability approval.`,
      );
    }
    const existing = existingByServerId.get(server.id);
    if (existing?.status === 'active') continue;
    const binding: AgentMcpServerBinding = {
      id: `agent-mcp-binding:${input.agentId}:${server.id}` as AgentMcpServerBinding['id'],
      appId: input.appId,
      agentId: input.agentId,
      serverId: server.id,
      status: 'active',
      required: existing?.required ?? false,
      permissionPolicyIds: existing?.permissionPolicyIds ?? [],
      createdAt: existing?.createdAt ?? (input.timestamp as never),
      updatedAt: input.timestamp as never,
    };
    await input.mcpServerRepository.saveAgentBinding(binding);
    await input.mcpServerRepository.appendAuditEvent({
      id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
      appId: input.appId,
      agentId: input.agentId,
      serverId: server.id,
      bindingId: binding.id,
      eventType: 'bind',
      reason: 'Activated by persistent MCP capability approval.',
      metadata: {
        capabilitySource: 'persistent_permission_approval',
      },
      createdAt: input.timestamp as never,
    });
    activated.push(binding);
  }
  return activated;
}

function mcpServerNamesForRules(input: {
  rules: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): string[] {
  const out = new Set<string>();
  for (const rule of input.rules) {
    const capabilityId = parseSemanticCapabilityRule(rule);
    const capability = capabilityId
      ? input.semanticCapabilityDefinitions?.[capabilityId]
      : undefined;
    if (!capability) continue;
    for (const binding of capability.implementationBindings) {
      if (binding.kind !== 'mcp_tool') continue;
      const serverName = mcpServerNameFromTool(binding.mcpTool);
      if (serverName) out.add(serverName);
    }
  }
  return [...out].sort();
}

function mcpServerNameFromTool(toolName: string | undefined): string | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName?.trim() ?? '');
  return match?.[1] ?? null;
}
