import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerRepository, SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from './mcp-server-policy.js';
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
export declare function materializeSourceMcpCapabilities(input: MaterializeMcpProxyCapabilitiesInput): Promise<ReviewedMaterializedMcpCapability[]>;
export declare function materializeReviewedMcpCapabilities(input: MaterializeMcpProxyCapabilitiesInput): Promise<ReviewedMaterializedMcpCapability[]>;
export {};
