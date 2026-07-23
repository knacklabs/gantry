import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { reviewedExternalMcpToolPatternsFromRuntimeAccess } from '../../shared/capability-runtime-access.js';
import { intersectMcpToolRulesWithSourceScopes } from '../../shared/mcp-tool-scope.js';
import { resolveAgentToolRuntimePolicy } from '../agents/agent-tool-runtime-rules.js';
import { authorizedMcpServerIdsForAgent } from './mcp-authorized-servers.js';
import type { RemoteMcpDnsValidationCache } from './mcp-server-policy.js';
import { McpServerService } from './mcp-server-service.js';
import type { ReviewedMaterializedMcpCapability } from './mcp-tool-authorization.js';

interface MaterializeMcpProxyCapabilitiesInput {
  mcpServers: McpServerRepository;
  tools: ToolCatalogRepository;
  skills?: SkillCatalogRepository;
  credentialEnv?: Record<string, string>;
  liveToolRules?: readonly string[];
  sourceServerIds?: readonly string[];
  lookupHostname?: HostnameLookup;
  dnsValidationCache?: RemoteMcpDnsValidationCache;
  appId: AppId;
  agentId: AgentId;
}

export async function materializeSourceMcpCapabilities(
  input: MaterializeMcpProxyCapabilitiesInput,
): Promise<ReviewedMaterializedMcpCapability[]> {
  const capabilities = await new McpServerService(input.mcpServers, undefined, {
    lookupHostname: input.lookupHostname,
    dnsValidationCache: input.dnsValidationCache,
    auditMaterialization: false,
  }).materializeForAgent({
    appId: input.appId,
    agentId: input.agentId,
    serverIds: input.sourceServerIds as never,
    credentialEnv: input.credentialEnv ?? {},
  });
  return capabilities.map((capability) => ({
    ...capability,
    reviewedToolNames: capability.allowedToolNames,
  }));
}

export async function materializeReviewedMcpCapabilities(
  input: MaterializeMcpProxyCapabilitiesInput,
): Promise<ReviewedMaterializedMcpCapability[]> {
  const policy = await resolveAgentToolRuntimePolicy({
    repository: input.tools,
    skillRepository: input.skills,
    appId: input.appId,
    agentId: input.agentId,
    errorSubject: 'Configured agent tool',
  });
  // Reviewed patterns come only from selected capability bindings, never from
  // live rules: transient exact rules cannot create MCP action authority.
  const reviewedToolPatterns = reviewedExternalMcpToolPatternsFromRuntimeAccess(
    policy.runtimeAccess,
  );
  const serverIds = await authorizedMcpServerIdsForAgent({
    mcpServers: input.mcpServers,
    appId: input.appId,
    agentId: input.agentId,
  });
  const capabilities = await new McpServerService(input.mcpServers, undefined, {
    lookupHostname: input.lookupHostname,
    dnsValidationCache: input.dnsValidationCache,
    auditMaterialization: false,
  }).materializeForAgent({
    appId: input.appId,
    agentId: input.agentId,
    serverIds: serverIds as never,
    credentialEnv: input.credentialEnv ?? {},
  });
  return capabilities.map((capability) => {
    const serverPrefix = `mcp__${capability.name}__`;
    const sourceScopedRules = intersectMcpToolRulesWithSourceScopes(
      reviewedToolPatterns,
      [
        {
          name: capability.name,
          allowedToolPatterns: capability.allowedToolPatterns,
        },
      ],
    );
    return {
      ...capability,
      reviewedToolNames: sourceScopedRules.filter(
        (rule) => !rule.endsWith('*'),
      ),
      reviewedToolPatterns: sourceScopedRules.filter((rule) =>
        rule.startsWith(serverPrefix),
      ),
      reviewedCapabilityIds: [
        ...new Set(
          policy.runtimeAccess.flatMap((access) =>
            access.sourceType === 'mcp_server' &&
            (access.reviewedServerId === capability.name ||
              access.allowedTools.some((tool) =>
                tool.trim().startsWith(serverPrefix),
              ))
              ? [access.selectedCapabilityId]
              : [],
          ),
        ),
      ],
    };
  });
}
