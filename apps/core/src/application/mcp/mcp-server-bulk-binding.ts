import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentMcpServerBinding,
  McpServerDefinition,
  McpServerId,
} from '../../domain/mcp/mcp-servers.js';
import { isMcpServerActive } from '../../domain/mcp/mcp-servers.js';
import type {
  AgentRepository,
  McpServerRepository,
} from '../../domain/ports/repositories.js';
import { nowIso } from '../../shared/time/datetime.js';
import { ApplicationError } from '../common/application-error.js';

type Audit = (input: {
  appId: AppId;
  agentId: AgentId;
  serverId: McpServerId;
  bindingId: AgentMcpServerBinding['id'];
  eventType: 'bind';
}) => Promise<void>;

export async function bindAgentsToMcpServer(input: {
  agents?: AgentRepository;
  appId: AppId;
  agentIds: AgentId[];
  audit: Audit;
  mcpServers: McpServerRepository;
  requireServer: (
    appId: AppId,
    serverId: McpServerId,
  ) => Promise<McpServerDefinition>;
  serverId: McpServerId;
}): Promise<AgentMcpServerBinding[]> {
  if (!input.agents) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Agent repository is required for bulk MCP binding.',
    );
  }
  const agentIds = [...new Set(input.agentIds)];
  if (agentIds.length === 0 || agentIds.length !== input.agentIds.length) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Choose one or more distinct agents.',
    );
  }
  const server = await input.requireServer(input.appId, input.serverId);
  if (!isMcpServerActive(server)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `MCP server must be active before binding: ${server.id}`,
    );
  }
  const agents = await input.agents.listAgents(input.appId);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  for (const agentId of agentIds) {
    const agent = agentsById.get(agentId);
    if (!agent)
      throw new ApplicationError('NOT_FOUND', `Agent not found: ${agentId}`);
    if (agent.status !== 'active') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Agent must be active before binding: ${agentId}`,
      );
    }
  }
  const existing = await input.mcpServers.listAgentBindingsForAgents({
    appId: input.appId,
    agentIds,
  });
  if (
    existing.some(
      (binding) =>
        binding.serverId === input.serverId && binding.status === 'active',
    )
  ) {
    throw new ApplicationError(
      'CONFLICT',
      'One or more selected agents already have this source attached.',
    );
  }
  const latestServer = await input.requireServer(input.appId, input.serverId);
  if (!isMcpServerActive(latestServer)) {
    throw new ApplicationError(
      'CONFLICT',
      `MCP server changed before binding completed: ${input.serverId}`,
    );
  }
  const now = nowIso();
  const bindings = agentIds.map((agentId) => ({
    id: `agent-mcp-binding:${agentId}:${input.serverId}` as AgentMcpServerBinding['id'],
    appId: input.appId,
    agentId,
    serverId: input.serverId,
    status: 'active' as const,
    required: false,
    permissionPolicyIds: [],
    allowedToolPatterns: [],
    createdAt: now,
    updatedAt: now,
  }));
  await input.mcpServers.saveAgentBindingsBatch(bindings);
  await Promise.all(
    bindings.map((binding) =>
      input.audit({
        appId: input.appId,
        agentId: binding.agentId,
        serverId: input.serverId,
        bindingId: binding.id,
        eventType: 'bind',
      }),
    ),
  );
  return bindings;
}
