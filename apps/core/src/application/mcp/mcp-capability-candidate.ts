import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import {
  mcpToolPatternCovers,
  normalizeMcpToolScope,
  reviewedMcpToolPatterns,
} from '../../shared/mcp-tool-scope.js';
import {
  type SemanticCapabilityDefinition,
  type SemanticCapabilityRisk,
  validateSemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { assertMcpCapabilityScopeReviewable } from './mcp-capability-review-scope.js';
import { mcpServerDefinitionFingerprint } from './mcp-server-definition-fingerprint.js';
import { mcpBindingMatchesRouteScope } from './mcp-authorized-servers.js';

export interface ReviewedMcpCapabilityCandidate {
  definition: SemanticCapabilityDefinition;
  serverName: string;
  patterns: string[];
  resolvedTools: string[];
}

export async function buildReviewedMcpCapabilityCandidate(input: {
  mcpServers: McpServerRepository;
  appId: AppId;
  agentId: AgentId;
  serverName: string;
  tools: readonly string[];
  risk: Extract<SemanticCapabilityRisk, 'read' | 'write'>;
  displayName: string;
  conversationId?: string;
  threadId?: string;
}): Promise<ReviewedMcpCapabilityCandidate> {
  const serverName = input.serverName.trim();
  const server = await input.mcpServers.getServerByName({
    appId: input.appId,
    name: serverName,
  });
  const bindings = await input.mcpServers.listAgentBindings({
    appId: input.appId,
    agentId: input.agentId,
  });
  const activeBinding = server
    ? bindings.find(
        (binding) =>
          binding.status === 'active' &&
          binding.serverId === server.id &&
          mcpBindingMatchesRouteScope(binding, input),
      )
    : undefined;
  if (!server || server.status !== 'active' || !activeBinding) {
    throw new Error(
      `MCP source ${serverName || '(missing)'} is not active for this agent.`,
    );
  }

  const definitionPatterns = reviewedMcpToolPatterns(server);
  const effectiveSourcePatterns =
    activeBinding.allowedToolPatterns.length > 0
      ? normalizeMcpToolScope({
          serverName: server.name,
          requested: activeBinding.allowedToolPatterns,
          definitionPatterns,
        })
      : definitionPatterns;
  const patterns = normalizeMcpToolScope({
    serverName: server.name,
    requested: input.tools,
    definitionPatterns: effectiveSourcePatterns,
  }).sort();
  const displayName = input.displayName.trim();
  const serverDefinitionFingerprint = mcpServerDefinitionFingerprint(server);
  const capabilityId = mcpCapabilityCandidateId({
    appId: input.appId,
    serverName: server.name,
    serverDefinitionFingerprint,
    risk: input.risk,
    patterns,
  });
  const definition: SemanticCapabilityDefinition = {
    capabilityId,
    displayName,
    category: 'MCP',
    risk: input.risk,
    can: `Call reviewed ${server.name} MCP tools matching: ${patterns.join(', ')}.`,
    cannot: `Call other ${server.name} MCP tools or bypass the connected source scope.`,
    credentialSource: 'none',
    implementationBindings: [
      {
        kind: 'mcp_pattern',
        mcpServer: server.name,
        mcpToolPatterns: patterns,
      },
    ],
    preflight: { kind: 'none' },
    source: {
      kind: 'mcp_capability_proposal',
      serverId: server.id,
      serverName: server.name,
      serverDefinitionFingerprint,
    },
  };
  const validation = validateSemanticCapabilityDefinition(definition);
  if (!validation.ok) throw new Error(validation.reason);

  const resolvedTools = [
    ...new Set([
      ...patterns.filter((pattern) => !pattern.endsWith('*')),
      ...effectiveSourcePatterns
        .map((pattern) => pattern.trim())
        .filter(
          (toolName) =>
            toolName &&
            !toolName.endsWith('*') &&
            patterns.some((pattern) => mcpToolPatternCovers(pattern, toolName)),
        ),
    ]),
  ].sort();
  assertMcpCapabilityScopeReviewable({
    displayName,
    serverName: server.name,
    risk: input.risk,
    patterns,
    resolvedTools,
  });
  return { definition, serverName: server.name, patterns, resolvedTools };
}

function mcpCapabilityCandidateId(input: {
  appId: AppId;
  serverName: string;
  serverDefinitionFingerprint: string;
  risk: 'read' | 'write';
  patterns: readonly string[];
}): string {
  const serverSegment = input.serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const digest = stableSha256Json({
    appId: input.appId,
    serverName: input.serverName,
    serverDefinitionFingerprint: input.serverDefinitionFingerprint,
    risk: input.risk,
    patterns: [...input.patterns].sort(),
  }).slice(0, 12);
  return `mcp.${serverSegment}.${input.risk}.${digest}`;
}
