import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import {
  mcpBindingAuthorityPrecondition,
  type AgentMcpServerBinding,
  type McpBindingAuthorityPrecondition,
} from '../../domain/mcp/mcp-servers.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import {
  normalizeMcpToolScope,
  reviewedMcpToolPatterns,
} from '../../shared/mcp-tool-scope.js';
import { mcpServerDefinitionFingerprint } from '../mcp/mcp-server-definition-fingerprint.js';

export interface AppliedMcpSourceBinding {
  binding: AgentMcpServerBinding;
  previous?: AgentMcpServerBinding;
}

export interface EnsuredMcpSourceBindings {
  applied: AppliedMcpSourceBinding[];
  proposalBindingSnapshots: McpBindingAuthorityPrecondition[];
}

export async function withMcpCapabilityProposalSourceLocks<T>(input: {
  appId: AppId;
  agentId: AgentId;
  mcpServerRepository?: McpServerRepository;
  rules: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  operation: () => Promise<T>;
}): Promise<T> {
  const proposalSources = [
    ...mcpServerToolPatternsForRules({
      rules: input.rules,
      semanticCapabilityDefinitions: input.semanticCapabilityDefinitions,
    }).entries(),
  ].filter(([, scope]) => scope.requireExistingBinding);
  if (proposalSources.length === 0) return input.operation();
  const repository = input.mcpServerRepository;
  if (!repository?.withMcpCapabilityApprovalLock) {
    throw new Error(
      'MCP source repository with approval locking is required for persistent MCP capability approval.',
    );
  }
  return repository.withMcpCapabilityApprovalLock<T>({
    appId: input.appId,
    serverNames: proposalSources.map(([serverName]) => serverName),
    operation: input.operation,
  });
}

interface RequestedMcpSourceScope {
  patterns: Set<string>;
  requireExistingBinding: boolean;
  expectedServerId?: string;
  expectedServerDefinitionFingerprint?: string;
}

export async function ensureMcpSourceBindingsForRules(input: {
  appId: AppId;
  agentId: AgentId;
  mcpServerRepository?: McpServerRepository;
  rules: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  timestamp: string;
}): Promise<EnsuredMcpSourceBindings> {
  const requestedPatternsByServerName = mcpServerToolPatternsForRules({
    rules: input.rules,
    semanticCapabilityDefinitions: input.semanticCapabilityDefinitions,
  });
  if (requestedPatternsByServerName.size === 0) {
    return { applied: [], proposalBindingSnapshots: [] };
  }
  if (!input.mcpServerRepository) {
    if (
      [...requestedPatternsByServerName.values()].some(
        (scope) => scope.requireExistingBinding,
      )
    ) {
      throw new Error(
        'MCP source repository is required for persistent MCP capability approval.',
      );
    }
    return { applied: [], proposalBindingSnapshots: [] };
  }
  const existingBindings = await input.mcpServerRepository.listAgentBindings({
    appId: input.appId,
    agentId: input.agentId,
  });
  const existingByServerId = new Map(
    existingBindings.map((binding) => [binding.serverId, binding]),
  );
  const activated: AppliedMcpSourceBinding[] = [];
  const proposalBindingSnapshots: McpBindingAuthorityPrecondition[] = [];
  try {
    for (const [serverName, requestedScope] of requestedPatternsByServerName) {
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
      if (requestedScope.requireExistingBinding) {
        if (
          requestedScope.expectedServerId &&
          requestedScope.expectedServerId !== server.id
        ) {
          throw new Error(
            `MCP source ${serverName} no longer matches the server reviewed in this capability request. Request the capability again.`,
          );
        }
        if (
          requestedScope.expectedServerDefinitionFingerprint &&
          requestedScope.expectedServerDefinitionFingerprint !==
            mcpServerDefinitionFingerprint(server)
        ) {
          throw new Error(
            `MCP source ${serverName} definition changed after this capability request was reviewed. Request the capability again.`,
          );
        }
        if (!existing || existing.status !== 'active') {
          throw new Error(
            `MCP source ${serverName} is no longer active for this agent. Request the capability again after reconnecting it.`,
          );
        }
        const effectiveSourcePatterns =
          existing.allowedToolPatterns.length > 0
            ? normalizeMcpToolScope({
                serverName: server.name,
                requested: existing.allowedToolPatterns,
                definitionPatterns,
              })
            : definitionPatterns;
        normalizeMcpToolScope({
          serverName: server.name,
          requested: [...requestedScope.patterns],
          definitionPatterns: effectiveSourcePatterns,
        });
        proposalBindingSnapshots.push(
          mcpBindingAuthorityPrecondition(existing),
        );
        continue;
      }
      const normalizedRequestedScope = normalizeMcpToolScope({
        serverName: server.name,
        requested: [...requestedScope.patterns],
        definitionPatterns,
      });
      const allowedToolPatterns = mergeMcpToolPatterns({
        existing:
          existing?.status === 'active'
            ? existing.allowedToolPatterns
            : undefined,
        requested: normalizedRequestedScope,
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
        conversationId: existing?.conversationId,
        threadId: existing?.threadId,
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
  return { applied: activated, proposalBindingSnapshots };
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
}): Map<string, RequestedMcpSourceScope> {
  const out = new Map<string, RequestedMcpSourceScope>();
  for (const rule of input.rules) {
    const capabilityId = parseSemanticCapabilityRule(rule);
    const capability = capabilityId
      ? input.semanticCapabilityDefinitions?.[capabilityId]
      : undefined;
    if (!capability) continue;
    const source = parseMcpCapabilitySource(capability.source);
    if (source?.serverName && source.allowedToolPatterns.length > 0) {
      addRequestedMcpSourceScope(out, {
        serverName: source.serverName,
        patterns: source.allowedToolPatterns,
        requireExistingBinding: false,
      });
      continue;
    }
    const proposalSource = parseMcpCapabilityProposalSource(capability.source);
    if (isMcpCapabilityProposalSource(capability.source) && !proposalSource) {
      throw new Error('MCP capability proposal source metadata is invalid.');
    }
    for (const binding of capability.implementationBindings) {
      if (binding.kind === 'mcp_pattern') {
        const serverName = binding.mcpServer?.trim();
        const patterns = (binding.mcpToolPatterns ?? [])
          .map((pattern) => pattern.trim())
          .filter(Boolean);
        if (!serverName || patterns.length === 0) continue;
        addRequestedMcpSourceScope(out, {
          serverName,
          patterns,
          requireExistingBinding: proposalSource?.serverName === serverName,
          expectedServerId:
            proposalSource?.serverName === serverName
              ? proposalSource.serverId
              : undefined,
          expectedServerDefinitionFingerprint:
            proposalSource?.serverName === serverName
              ? proposalSource.serverDefinitionFingerprint
              : undefined,
        });
        continue;
      }
      if (binding.kind !== 'mcp_tool') continue;
      const parsed = mcpServerAndToolFromRule(binding.mcpTool);
      if (!parsed) continue;
      addRequestedMcpSourceScope(out, {
        serverName: parsed.serverName,
        patterns: [parsed.toolName],
        requireExistingBinding: false,
      });
    }
  }
  const sortedEntries: Array<[string, RequestedMcpSourceScope]> = [
    ...out.entries(),
  ]
    .map(([serverName, scope]): [string, RequestedMcpSourceScope] => [
      serverName,
      {
        ...scope,
        patterns: new Set([...scope.patterns].sort()),
      },
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  return new Map(sortedEntries);
}

function addRequestedMcpSourceScope(
  target: Map<string, RequestedMcpSourceScope>,
  input: {
    serverName: string;
    patterns: readonly string[];
    requireExistingBinding: boolean;
    expectedServerId?: string;
    expectedServerDefinitionFingerprint?: string;
  },
): void {
  const existing = target.get(input.serverName) ?? {
    patterns: new Set<string>(),
    requireExistingBinding: false,
  };
  if (
    existing.expectedServerId &&
    input.expectedServerId &&
    existing.expectedServerId !== input.expectedServerId
  ) {
    throw new Error(
      `MCP source ${input.serverName} has conflicting reviewed server identities.`,
    );
  }
  if (
    existing.expectedServerDefinitionFingerprint &&
    input.expectedServerDefinitionFingerprint &&
    existing.expectedServerDefinitionFingerprint !==
      input.expectedServerDefinitionFingerprint
  ) {
    throw new Error(
      `MCP source ${input.serverName} has conflicting reviewed server definitions.`,
    );
  }
  for (const pattern of input.patterns) existing.patterns.add(pattern);
  existing.requireExistingBinding ||= input.requireExistingBinding;
  existing.expectedServerId ??= input.expectedServerId;
  existing.expectedServerDefinitionFingerprint ??=
    input.expectedServerDefinitionFingerprint;
  target.set(input.serverName, existing);
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

function parseMcpCapabilityProposalSource(source: unknown): {
  serverName: string;
  serverId: string;
  serverDefinitionFingerprint: string;
} | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }
  const record = source as Record<string, unknown>;
  if (
    record.kind !== 'mcp_capability_proposal' ||
    typeof record.serverName !== 'string' ||
    typeof record.serverId !== 'string' ||
    typeof record.serverDefinitionFingerprint !== 'string'
  ) {
    return null;
  }
  const serverName = record.serverName.trim();
  const serverId = record.serverId.trim();
  const serverDefinitionFingerprint = record.serverDefinitionFingerprint.trim();
  return serverName && serverId && serverDefinitionFingerprint
    ? { serverName, serverId, serverDefinitionFingerprint }
    : null;
}

function isMcpCapabilityProposalSource(source: unknown): boolean {
  return Boolean(
    source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    (source as Record<string, unknown>).kind === 'mcp_capability_proposal',
  );
}

function mcpServerAndToolFromRule(
  toolName: string | undefined,
): { serverName: string; toolName: string } | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(toolName?.trim() ?? '');
  if (!match) return null;
  return { serverName: match[1], toolName: match[2] };
}
