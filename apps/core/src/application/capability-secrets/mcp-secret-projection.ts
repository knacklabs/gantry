import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerId } from '../../domain/mcp/mcp-servers.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
} from '../../domain/ports/repositories.js';
import { CapabilitySecretService } from './capability-secret-service.js';

export async function resolveMcpCredentialEnvForAgent(input: {
  appId: AppId;
  agentId: AgentId;
  mcpServers: McpServerRepository;
  secrets: CapabilitySecretRepository;
  serverIds?: readonly McpServerId[];
}): Promise<Record<string, string>> {
  const records = await input.mcpServers.listMaterializedServersForAgent({
    appId: input.appId,
    agentId: input.agentId,
    ...(input.serverIds ? { serverIds: input.serverIds } : {}),
  });
  const service = new CapabilitySecretService(input.secrets);
  const credentialEnv: Record<string, string> = {};
  for (const record of records) {
    const refs = [
      ...record.version.credentialRefs.map((ref) => ref.name),
      ...(record.version.config.callerIdentity?.mode === 'required'
        ? [record.version.config.callerIdentity.signingRef]
        : []),
    ];
    if (refs.length === 0) continue;
    const resolved = await service.resolveEnv({
      appId: input.appId,
      names: refs,
      allowedCapabilityIds: [
        record.definition.id,
        `mcp:${record.definition.name}`,
      ],
    });
    Object.assign(credentialEnv, resolved.env);
  }
  return credentialEnv;
}
