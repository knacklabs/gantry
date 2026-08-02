import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerId } from '../../domain/mcp/mcp-servers.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
} from '../../domain/ports/repositories.js';
import {
  type AgentAccessSnapshot,
  assertHostAccessSnapshot,
} from '../agent-execution/agent-access-snapshot.js';
import { CapabilitySecretService } from './capability-secret-service.js';

export async function resolveMcpCredentialEnvForAgent(input: {
  appId: AppId;
  agentId: AgentId;
  mcpServers: McpServerRepository;
  secrets: CapabilitySecretRepository;
  serverIds?: readonly McpServerId[];
  accessSnapshot?: AgentAccessSnapshot;
}): Promise<Record<string, string>> {
  const accessSnapshot = assertHostAccessSnapshot({
    accessSnapshot: input.accessSnapshot,
    appId: input.appId,
    agentId: input.agentId,
    subject: 'MCP credential projection',
  });
  const selectedIds = input.serverIds ? new Set(input.serverIds) : undefined;
  const records =
    accessSnapshot?.mcp.materializedServers.filter(
      (record) => !selectedIds || selectedIds.has(record.definition.id),
    ) ??
    (await input.mcpServers.listMaterializedServersForAgent({
      appId: input.appId,
      agentId: input.agentId,
      ...(input.serverIds ? { serverIds: input.serverIds } : {}),
    }));
  const service = new CapabilitySecretService(input.secrets);
  const credentialEnv: Record<string, string> = {};
  for (const record of records) {
    const refs = record.definition.credentialRefs;
    if (refs.length === 0) continue;
    const resolved = await service.resolveMcpCredentialRefs({
      appId: input.appId,
      refs,
      allowedCapabilityIds: [
        record.definition.id,
        `mcp:${record.definition.name}`,
      ],
    });
    Object.assign(credentialEnv, resolved.credentialEnv);
  }
  return credentialEnv;
}
