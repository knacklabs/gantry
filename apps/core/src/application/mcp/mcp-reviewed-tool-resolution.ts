import { ApplicationError } from '../common/application-error.js';
import {
  isReviewedMcpToolAllowed,
  type ReviewedMaterializedMcpCapability,
} from './mcp-tool-authorization.js';
import type { McpToolAuditResultClass } from './mcp-tool-audit.js';

export async function resolveReviewedMcpTool(input: {
  capabilities: ReviewedMaterializedMcpCapability[];
  serverName: string;
  toolName: string;
  finalizeDenied: (
    resultClass: McpToolAuditResultClass,
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
}): Promise<{
  capability: ReviewedMaterializedMcpCapability;
  selectedToolRule: string;
  selectedCapability: Pick<
    ReviewedMaterializedMcpCapability,
    'name' | 'serverId' | 'bindingId' | 'sourceRevision'
  >;
}> {
  const capability = input.capabilities.find(
    (candidate) => candidate.name === input.serverName,
  );
  if (!capability) {
    const reason = `MCP server is not approved for this agent: ${input.serverName}`;
    await input.finalizeDenied('denied', { reason });
    throw new ApplicationError('NOT_FOUND', reason);
  }
  const selectedToolRule = `mcp__${capability.name}__${input.toolName}`;
  const selectedCapability = {
    name: capability.name,
    serverId: capability.serverId,
    bindingId: capability.bindingId,
    ...(capability.sourceRevision
      ? { sourceRevision: capability.sourceRevision }
      : {}),
  };
  if (!isReviewedMcpToolAllowed(capability, input.toolName)) {
    const reason = `MCP tool is not approved for this agent: ${selectedToolRule}. ${reviewedCapabilityDenialGuidance(capability)}`;
    await input.finalizeDenied('denied', {
      reason,
      selectedToolRule,
      selectedCapability,
    });
    throw new ApplicationError('FORBIDDEN', reason);
  }
  return { capability, selectedToolRule, selectedCapability };
}

// Names the nearest reviewed capability (or says none covers the server).
// Kept mode-neutral: locked/fixed-image agents have request tools hidden, so
// the guidance never instructs calling one.
function reviewedCapabilityDenialGuidance(
  capability: ReviewedMaterializedMcpCapability,
): string {
  const capabilityIds = [...(capability.reviewedCapabilityIds ?? [])].sort();
  if (capabilityIds.length === 0) {
    return `No selected reviewed capability covers MCP server ${capability.name}; a reviewed capability for this server must be provisioned before this tool can be used.`;
  }
  const label =
    capabilityIds.length === 1
      ? `Selected reviewed capability ${capabilityIds[0]} does`
      : `Selected reviewed capabilities ${capabilityIds.join(', ')} do`;
  return `${label} not cover this tool; a reviewed capability covering it must be provisioned before it can be used.`;
}
