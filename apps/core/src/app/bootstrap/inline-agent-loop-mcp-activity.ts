import type { McpToolAuditResultClass } from '../../application/mcp/mcp-tool-audit.js';
import type { McpCompatibleToolError } from '../../runtime/core-tools/contracts.js';

export type ThirdPartyMcpToolActivity = {
  serverName: string;
  toolName: string;
  toolInput: unknown;
  outcome: 'attempt' | 'success' | 'failure';
  latencyMs: number;
  result?: unknown;
  error?: unknown;
  resultClass?: McpToolAuditResultClass;
  structuredError?: McpCompatibleToolError;
};

export function isSuccessfulMcpActivity(
  activity: ThirdPartyMcpToolActivity,
): boolean {
  if (
    activity.outcome !== 'success' ||
    activity.error ||
    activity.structuredError
  ) {
    return false;
  }
  if (isMcpErrorResult(activity.result)) return false;
  if (activity.resultClass !== undefined) {
    return activity.resultClass === 'success';
  }
  return activity.result !== undefined;
}

export function isMcpErrorResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { isError?: unknown }).isError === true
  );
}
