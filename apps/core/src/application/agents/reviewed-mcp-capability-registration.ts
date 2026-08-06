import type { AppId } from '../../domain/app/app.js';
import {
  isMcpServerActive,
  type McpServerDefinition,
} from '../../domain/mcp/mcp-servers.js';
import type {
  McpServerRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import type { ToolCatalogItem } from '../../domain/tools/tools.js';
import { mcpToolPatternCovers } from '../../shared/mcp-tool-scope.js';
import { semanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import {
  semanticCapabilityFromToolCatalogItem,
  type SemanticCapabilityDefinition,
  validateSemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { ApplicationError } from '../common/application-error.js';

export interface ReviewedMcpCapabilityInput {
  appId: AppId;
  capability: SemanticCapabilityDefinition;
}

export async function registerReviewedMcpCapability(
  input: ReviewedMcpCapabilityInput & {
    repositories: {
      tools: ToolCatalogRepository;
      mcpServers: McpServerRepository;
    };
    now: string;
  },
): Promise<ToolCatalogItem> {
  const capability = canonicalReviewedCapability(input.capability);
  const validation = validateSemanticCapabilityDefinition(capability);
  if (!validation.ok) {
    throw new ApplicationError('INVALID_REQUEST', validation.reason);
  }
  if (
    capability.credentialSource !== 'configured_access' ||
    capability.implementationBindings.some(
      (binding) => binding.kind !== 'mcp_pattern',
    )
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Reviewed MCP capabilities require configured_access and exact MCP bindings.',
    );
  }

  const reviewedSources = new Map<string, McpServerDefinition>();
  for (const binding of capability.implementationBindings) {
    const serverName = binding.mcpServer!;
    const source =
      reviewedSources.get(serverName) ??
      (await input.repositories.mcpServers.getServerByName({
        appId: input.appId,
        name: serverName,
      }));
    if (!source || source.appId !== input.appId) {
      throw new ApplicationError(
        'NOT_FOUND',
        `Active MCP source not found: ${serverName}`,
      );
    }
    if (!isMcpServerActive(source)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP source is not active: ${serverName}`,
      );
    }
    for (const toolName of binding.mcpToolPatterns ?? []) {
      if (
        !source.allowedToolPatterns.some((pattern) =>
          mcpToolPatternCovers(pattern, toolName),
        )
      ) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `MCP tool mcp__${serverName}__${toolName} is not allowed by source ${serverName}.`,
        );
      }
    }
    reviewedSources.set(serverName, source);
  }

  const existing = (
    await input.repositories.tools.listTools({ appId: input.appId })
  ).find(
    (tool) => tool.name === semanticCapabilityRule(capability.capabilityId),
  );
  if (existing) {
    const current = semanticCapabilityFromToolCatalogItem({
      name: existing.name,
      inputSchema: existing.inputSchema,
    });
    const canonicalCurrent = current
      ? tryCanonicalReviewedCapability(current)
      : tryCanonicalStoredReviewedCapability(existing.inputSchema);
    if (
      canonicalCurrent &&
      stableSha256Json(canonicalCurrent) === stableSha256Json(capability)
    ) {
      if (
        current &&
        stableSha256Json(current) === stableSha256Json(capability)
      ) {
        return existing;
      }
      return ensureAgentToolCatalogItem({
        repository: input.repositories.tools,
        appId: input.appId,
        reference: semanticCapabilityRule(capability.capabilityId),
        now: input.now,
        semanticCapabilityDefinitions: {
          [capability.capabilityId]: capability,
        },
      });
    }
    throw new ApplicationError(
      'CONFLICT',
      `Capability ${capability.capabilityId} is already registered with a different immutable manifest.`,
    );
  }

  const tool = await ensureAgentToolCatalogItem({
    repository: input.repositories.tools,
    appId: input.appId,
    reference: semanticCapabilityRule(capability.capabilityId),
    now: input.now,
    semanticCapabilityDefinitions: {
      [capability.capabilityId]: capability,
    },
  });
  await Promise.all(
    [...reviewedSources.values()].map((source) =>
      input.repositories.mcpServers.appendAuditEvent({
        id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
        appId: input.appId,
        serverId: source.id,
        eventType: 'capability_register',
        reason: 'Reviewed semantic MCP capability registered.',
        metadata: {
          capabilityId: capability.capabilityId,
          version: capability.version ?? 'catalog',
          tools: capability.implementationBindings.map(
            (binding) =>
              `mcp__${binding.mcpServer}__${binding.mcpToolPatterns?.[0]}`,
          ),
        },
        createdAt: input.now as never,
      }),
    ),
  );
  return tool;
}

function tryCanonicalStoredReviewedCapability(
  inputSchema: unknown,
): SemanticCapabilityDefinition | undefined {
  if (!inputSchema || typeof inputSchema !== 'object') return undefined;
  const record = inputSchema as Record<string, unknown>;
  if (record.format !== 'gantry.semantic-capability.v1') return undefined;
  if (!record.schema || typeof record.schema !== 'object') return undefined;
  return tryCanonicalReviewedCapability(
    record.schema as SemanticCapabilityDefinition,
  );
}

function tryCanonicalReviewedCapability(
  capability: SemanticCapabilityDefinition,
): SemanticCapabilityDefinition | undefined {
  try {
    const canonical = canonicalReviewedCapability(capability);
    return validateSemanticCapabilityDefinition(canonical).ok
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalReviewedCapability(
  capability: SemanticCapabilityDefinition,
): SemanticCapabilityDefinition {
  return {
    ...capability,
    implementationBindings: capability.implementationBindings.map((binding) => {
      if (binding.kind !== 'mcp_tool') return binding;
      const parsed = parseExactMcpTool(binding.mcpTool);
      if (!parsed) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `MCP capability binding must name one exact tool without wildcards: ${binding.mcpTool ?? ''}`,
        );
      }
      return {
        kind: 'mcp_pattern' as const,
        mcpServer: parsed.serverName,
        mcpToolPatterns: [parsed.toolName],
      };
    }),
  };
}

function parseExactMcpTool(
  value: string | undefined,
): { serverName: string; toolName: string } | null {
  const match = /^mcp__([a-z][a-z0-9_-]{0,62})__([^*?\s]+)$/.exec(
    value?.trim() ?? '',
  );
  return match ? { serverName: match[1], toolName: match[2] } : null;
}
