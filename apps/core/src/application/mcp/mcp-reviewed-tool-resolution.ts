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
    const reason = `MCP tool is not approved for this agent: ${selectedToolRule}`;
    await input.finalizeDenied('denied', {
      reason,
      selectedToolRule,
      selectedCapability,
    });
    throw new ApplicationError('FORBIDDEN', reason);
  }
  return { capability, selectedToolRule, selectedCapability };
}
