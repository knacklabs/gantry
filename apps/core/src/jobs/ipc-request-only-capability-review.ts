import { skillActionDefinitionsForAgent } from '../application/agents/agent-capability-skill-actions.js';
import {
  buildReviewedMcpCapabilityCandidate,
  type ReviewedMcpCapabilityCandidate,
} from '../application/mcp/mcp-capability-candidate.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
import {
  isMcpCapabilityProposalDefinition,
  sameMcpCapabilityProposalAuthority,
  semanticCapabilityFromToolCatalogItem,
} from '../shared/semantic-capabilities.js';
import type { TaskContext } from './ipc-types.js';
import { sanitizedStringList, toTrimmedString } from './ipc-shared.js';

export type RequestOnlyCapabilityToolName =
  | 'request_skill_dependency_install'
  | 'request_permission';

export interface RequestOnlyCapabilityReview {
  toolName: RequestOnlyCapabilityToolName;
  requestKind: string;
  displayName: string;
  reason: string;
  toolInput: Record<string, unknown>;
  mcpCapabilityCandidate?: ReviewedMcpCapabilityCandidate;
}

export async function attachReviewedMcpCapabilityCandidate(input: {
  deps: TaskContext['deps'];
  appId: AppId;
  agentId: AgentId;
  conversationId?: string;
  threadId?: string;
  review: RequestOnlyCapabilityReview;
}): Promise<RequestOnlyCapabilityReview> {
  if (
    input.review.toolName !== 'request_permission' ||
    input.review.toolInput.capabilityProposalKind !== 'mcp_capability'
  ) {
    return input.review;
  }
  if (input.review.toolInput.capabilityRequestSource !== 'request_access') {
    throw new Error(
      'MCP capability proposals must use request_access target.kind=mcp_capability.',
    );
  }
  const mcpServers = input.deps.getMcpServerRepository?.();
  if (!mcpServers) {
    throw new Error(
      'MCP server repository unavailable for capability proposal review.',
    );
  }
  const serverName = toTrimmedString(input.review.toolInput.mcpServerName, {
    maxLen: 80,
  });
  const displayName = toTrimmedString(
    input.review.toolInput.capabilityDisplayName,
    { maxLen: 200 },
  );
  const risk = toTrimmedString(input.review.toolInput.risk, { maxLen: 16 });
  const tools = sanitizedStringList(
    Array.isArray(input.review.toolInput.mcpToolPatterns)
      ? input.review.toolInput.mcpToolPatterns
      : [],
  );
  if (!serverName || !displayName || tools.length === 0) {
    throw new Error(
      'MCP capability proposals require serverName, displayName, and at least one tool.',
    );
  }
  if (risk !== 'read' && risk !== 'write') {
    throw new Error('MCP capability proposal risk must be read or write.');
  }
  const candidate = await buildReviewedMcpCapabilityCandidate({
    mcpServers,
    appId: input.appId,
    agentId: input.agentId,
    serverName,
    tools,
    risk,
    displayName,
    conversationId: input.conversationId,
    threadId: input.threadId,
  });
  return {
    ...input.review,
    displayName: `MCP capability: ${candidate.definition.displayName}`,
    toolInput: {
      ...input.review.toolInput,
      capabilityId: candidate.definition.capabilityId,
      capabilityDisplayName: candidate.definition.displayName,
      risk: candidate.definition.risk,
      can: candidate.definition.can,
      cannot: candidate.definition.cannot,
      credentialSource: candidate.definition.credentialSource,
      mcpServerName: candidate.serverName,
      mcpToolPatterns: candidate.patterns,
      mcpResolvedTools: candidate.resolvedTools,
      effect: 'persistent_rule_when_always_allowed',
    },
    mcpCapabilityCandidate: candidate,
  };
}

export async function missingReviewedCapabilityCatalogEntry(input: {
  deps: TaskContext['deps'];
  appId: string;
  agentId: string;
  conversationId?: string;
  threadId?: string;
  review: RequestOnlyCapabilityReview;
}): Promise<string | undefined> {
  if (input.review.toolName !== 'request_permission') return undefined;
  const capabilityId = toTrimmedString(input.review.toolInput.capabilityId, {
    maxLen: 160,
  });
  if (!capabilityId) return undefined;
  const toolNames = sanitizedStringList([
    input.review.toolInput.toolName,
    ...(Array.isArray(input.review.toolInput.toolNames)
      ? input.review.toolInput.toolNames
      : []),
  ]);
  if (toolNames.length > 0) return undefined;
  const repository = input.deps.getToolRepository?.();
  if (repository && typeof repository.listTools === 'function') {
    const activeTools = await repository.listTools({
      appId: input.appId as never,
      statuses: ['active'],
    });
    const matched = activeTools.find((tool) => {
      if (tool.status !== 'active' || !tool.selectable) return false;
      const capability = semanticCapabilityFromToolCatalogItem({
        name: tool.name,
        inputSchema: tool.inputSchema,
      });
      return capability?.capabilityId === capabilityId;
    });
    if (matched) {
      const existing = semanticCapabilityFromToolCatalogItem({
        name: matched.name,
        inputSchema: matched.inputSchema,
      });
      const candidate = input.review.mcpCapabilityCandidate?.definition;
      if (candidate) {
        if (
          !existing ||
          !sameMcpCapabilityProposalAuthority(existing, candidate)
        ) {
          return `MCP capability ${capabilityId} conflicts with an active reviewed catalog definition.`;
        }
        input.review.mcpCapabilityCandidate = {
          ...input.review.mcpCapabilityCandidate!,
          definition: existing,
        };
        input.review.displayName = `MCP capability: ${existing.displayName}`;
        input.review.toolInput = {
          ...input.review.toolInput,
          capabilityDisplayName: existing.displayName,
          can: existing.can,
          cannot: existing.cannot,
          credentialSource: existing.credentialSource,
        };
        return undefined;
      }
      if (!existing || !isMcpCapabilityProposalDefinition(existing)) {
        return undefined;
      }
      const binding = existing.implementationBindings.find(
        (item) => item.kind === 'mcp_pattern',
      );
      if (
        !binding?.mcpServer ||
        !binding.mcpToolPatterns?.length ||
        (existing.risk !== 'read' && existing.risk !== 'write')
      ) {
        return `MCP capability ${capabilityId} has invalid reviewed source authority.`;
      }
      const mcpServers = input.deps.getMcpServerRepository?.();
      if (!mcpServers) {
        return 'MCP server repository unavailable for capability review.';
      }
      try {
        const reviewed = await buildReviewedMcpCapabilityCandidate({
          mcpServers,
          appId: input.appId as never,
          agentId: input.agentId as never,
          serverName: binding.mcpServer,
          tools: binding.mcpToolPatterns,
          risk: existing.risk,
          displayName: existing.displayName,
          conversationId: input.conversationId,
          threadId: input.threadId,
        });
        if (
          !sameMcpCapabilityProposalAuthority(existing, reviewed.definition)
        ) {
          return `MCP capability ${capabilityId} no longer matches its reviewed MCP source. Request the capability again.`;
        }
        input.review.mcpCapabilityCandidate = {
          ...reviewed,
          definition: existing,
        };
        input.review.displayName = `MCP capability: ${existing.displayName}`;
        input.review.toolInput = {
          ...input.review.toolInput,
          capabilityDisplayName: existing.displayName,
          risk: existing.risk,
          can: existing.can,
          cannot: existing.cannot,
          credentialSource: existing.credentialSource,
          mcpServerName: reviewed.serverName,
          mcpToolPatterns: reviewed.patterns,
          mcpResolvedTools: reviewed.resolvedTools,
          effect: 'persistent_rule_when_always_allowed',
        };
        return undefined;
      } catch (err) {
        return err instanceof Error
          ? err.message
          : `MCP capability ${capabilityId} could not be revalidated.`;
      }
    }
  }
  if (input.review.mcpCapabilityCandidate) return undefined;
  const skillRepository = input.deps.getSkillRepository?.();
  if (skillRepository) {
    const skillCapabilities = await skillActionDefinitionsForAgent({
      appId: input.appId as never,
      agentId: input.agentId as never,
      skillRepository,
    });
    if (skillCapabilities[capabilityId]) return undefined;
  }
  return 'Capability access requires an active reviewed capability catalog entry. Request the reviewed capability with request_access target.kind=capability.';
}
