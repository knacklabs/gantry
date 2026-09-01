import type { MaterializedMcpCapability } from './mcp-server-service.js';
import {
  mcpToolNameAllowedBySourceScope,
  mcpToolPatternCovers,
} from '../../shared/mcp-tool-scope.js';

export interface ReviewedMcpOperationContract {
  capabilityRef: string;
  mcpTool: string;
  schemaDialect: 'json-schema-draft-07';
  inputSchema: Record<string, unknown>;
  inputSchemaDigest: string;
  resultEnvelopeSchema?: Record<string, unknown>;
  resultEnvelopeSchemaDigest?: string;
  executionMode?: 'sync' | 'durable_async';
  requiresActiveJob?: boolean;
  deadlineMs?: number;
  suspensionCheckpoint?: {
    milestone: string;
    payloadPatch: Record<string, unknown>;
    invocationRefPath: string[];
  };
}

export type ReviewedMaterializedMcpCapability = MaterializedMcpCapability & {
  reviewedToolNames: string[];
  // Reviewed full-name patterns (mcp__server__prefix*) from selected
  // mcp_pattern capability bindings. Pattern matches authorize newly
  // discovered tools without an exact-list refresh.
  reviewedToolPatterns?: string[];
  // Selected capability ids that reviewed action on this server; used to name
  // the nearest reviewed capability in denials.
  reviewedCapabilityIds?: string[];
  reviewedOperationContracts?: ReviewedMcpOperationContract[];
};

export function isReviewedMcpToolAllowed(
  capability: ReviewedMaterializedMcpCapability,
  toolName: string,
): boolean {
  const fullToolName = toolName.startsWith('mcp__')
    ? toolName
    : `mcp__${capability.name}__${toolName}`;
  if (!reviewedToolNameAllowedBySourceScope(capability, fullToolName)) {
    return false;
  }
  if (capability.reviewedToolNames.includes(fullToolName)) return true;
  return (capability.reviewedToolPatterns ?? []).some((pattern) =>
    mcpToolPatternCovers(pattern, fullToolName),
  );
}

export function reviewedToolNameAllowedBySourceScope(
  capability: MaterializedMcpCapability,
  fullToolName: string,
): boolean {
  return mcpToolNameAllowedBySourceScope({
    serverName: capability.name,
    fullToolName,
    allowedToolPatterns: capability.allowedToolPatterns,
  });
}

export function isSourceInventoryToolAllowed(
  capability: MaterializedMcpCapability,
  toolName: string,
): boolean {
  const patterns =
    capability.allowedToolPatterns.length > 0
      ? capability.allowedToolPatterns
      : capability.allowedToolNames.map((name) =>
          name.replace(`mcp__${capability.name}__`, ''),
        );
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => mcpToolPatternCovers(pattern, toolName));
}
