import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import {
  normalizeMcpToolScope,
  reviewedMcpToolPatterns,
} from '../../shared/mcp-tool-scope.js';

export interface AppliedMcpSourceBinding {
  binding: AgentMcpServerBinding;
  previous?: AgentMcpServerBinding;
}

export async function ensureMcpSourceBindingsForRules(input: {
  appId: AppId;
  agentId: AgentId;
  mcpServerRepository?: McpServerRepository;
  rules: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  timestamp: string;
}): Promise<AppliedMcpSourceBinding[]> {
  const requestedPatternsByServerName = mcpServerToolPatternsForRules({
    rules: input.rules,
    semanticCapabilityDefinitions: input.semanticCapabilityDefinitions,
  });
  if (requestedPatternsByServerName.size === 0 || !input.mcpServerRepository) {
    return [];
  }
  const existingBindings = await input.mcpServerRepository.listAgentBindings({
    appId: input.appId,
    agentId: input.agentId,
    limit: 500,
  });
  const existingByServerId = new Map(
    existingBindings.map((binding) => [binding.serverId, binding]),
  );
  const activated: AppliedMcpSourceBinding[] = [];
  try {
    for (const [
      serverName,
      requestedPatterns,
    ] of requestedPatternsByServerName) {
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
      const definitionPatterns = reviewedMcpToolPatterns(server);
      const requestedScope = normalizeMcpToolScope({
        serverName: server.name,
        requested: requestedPatterns,
        definitionPatterns,
      });
      const allowedToolPatterns = mergeMcpToolPatterns({
        existing:
          existing?.status === 'active'
            ? existing.allowedToolPatterns
            : undefined,
        requested: requestedScope,
        serverName: server.name,
        definitionPatterns,
      });
      if (
        existing?.status === 'active' &&
        mcpToolPatternsEqual(
          existing.allowedToolPatterns ?? [],
          allowedToolPatterns,
        )
      ) {
        continue;
      }
      const binding: AgentMcpServerBinding = {
        id: `agent-mcp-binding:${input.agentId}:${server.id}` as AgentMcpServerBinding['id'],
        appId: input.appId,
        agentId: input.agentId,
        serverId: server.id,
        status: 'active',
        required: existing?.required ?? false,
        permissionPolicyIds: existing?.permissionPolicyIds ?? [],
        allowedToolPatterns,
        createdAt: existing?.createdAt ?? (input.timestamp as never),
        updatedAt: input.timestamp as never,
      };
      await input.mcpServerRepository.saveAgentBinding(binding);
      activated.push({ binding, previous: existing });
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
    }
  } catch (err) {
    await rollbackAppliedMcpSourceBindings({
      appId: input.appId,
      agentId: input.agentId,
      mcpServerRepository: input.mcpServerRepository,
      applied: activated,
      timestamp: input.timestamp,
    });
    throw err;
  }
  return activated;
}

export async function rollbackAppliedMcpSourceBindings(input: {
  appId: AppId;
  agentId: AgentId;
  mcpServerRepository?: McpServerRepository;
  applied: readonly AppliedMcpSourceBinding[];
  timestamp: string;
}): Promise<void> {
  await Promise.allSettled(
    input.applied.map((applied) => {
      if (applied.previous) {
        return input.mcpServerRepository?.saveAgentBinding(applied.previous);
      }
      const binding = applied.binding;
      return input.mcpServerRepository?.disableAgentBinding({
        appId: input.appId,
        agentId: input.agentId,
        serverId: binding.serverId,
        updatedAt: input.timestamp as never,
      });
    }),
  );
}

function mergeMcpToolPatterns(input: {
  existing: readonly string[] | undefined;
  requested: readonly string[];
  serverName: string;
  definitionPatterns: readonly string[];
}): string[] {
  if (!input.existing) return [...input.requested];
  if (input.existing.length === 0) return [];
  return normalizeMcpToolScope({
    serverName: input.serverName,
    requested: [...input.existing, ...input.requested],
    definitionPatterns: input.definitionPatterns,
  });
}

function mcpToolPatternsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function mcpServerToolPatternsForRules(input: {
  rules: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const rule of input.rules) {
    const capabilityId = parseSemanticCapabilityRule(rule);
    const capability = capabilityId
      ? input.semanticCapabilityDefinitions?.[capabilityId]
      : undefined;
    if (!capability) continue;
    const source = parseMcpCapabilitySource(capability.source);
    if (source?.serverName && source.allowedToolPatterns.length > 0) {
      const existing = out.get(source.serverName) ?? new Set();
      for (const pattern of source.allowedToolPatterns) {
        existing.add(pattern);
      }
      out.set(source.serverName, existing);
      continue;
    }
    for (const binding of capability.implementationBindings) {
      if (binding.kind !== 'mcp_tool') continue;
      const parsed = mcpServerAndToolFromRule(binding.mcpTool);
      if (!parsed) continue;
      const existing = out.get(parsed.serverName) ?? new Set<string>();
      existing.add(parsed.toolName);
      out.set(parsed.serverName, existing);
    }
  }
  const sortedEntries: Array<[string, string[]]> = [...out.entries()]
    .map(([serverName, patterns]): [string, string[]] => [
      serverName,
      [...patterns].sort(),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  return new Map(sortedEntries);
}

function parseMcpCapabilitySource(
  source: unknown,
): { serverName: string; allowedToolPatterns: string[] } | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }
  const record = source as Record<string, unknown>;
  if (record.source !== 'mcp' || typeof record.serverName !== 'string') {
    return null;
  }
  const allowedToolPatterns = Array.isArray(record.allowedToolPatterns)
    ? record.allowedToolPatterns
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  return {
    serverName: record.serverName.trim(),
    allowedToolPatterns,
  };
}

function mcpServerAndToolFromRule(
  toolName: string | undefined,
): { serverName: string; toolName: string } | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(toolName?.trim() ?? '');
  if (!match) return null;
  return { serverName: match[1], toolName: match[2] };
}
