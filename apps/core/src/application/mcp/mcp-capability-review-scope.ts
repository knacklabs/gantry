import {
  redactSensitiveText,
  sanitizeOutboundLlmText,
} from '../../shared/sensitive-material.js';

export const MCP_CAPABILITY_SCOPE_REVIEW_MAX_CHARS = 3_500;

export function formatMcpCapabilityScopeReview(input: {
  displayName: string;
  serverName: string;
  risk: 'read' | 'write';
  patterns: readonly string[];
  resolvedTools: readonly string[];
}): string {
  return [
    `Capability: ${input.displayName}`,
    `Server: ${input.serverName}`,
    `Risk: ${input.risk}`,
    'Reviewed patterns:',
    ...input.patterns.map((pattern) => `- ${pattern}`),
    'Resolved exact tools:',
    ...(input.resolvedTools.length > 0
      ? input.resolvedTools.map((toolName) => `- ${toolName}`)
      : ['- none resolved from current source scope']),
  ].join('\n');
}

export function assertMcpCapabilityScopeReviewable(input: {
  displayName: string;
  serverName: string;
  risk: 'read' | 'write';
  patterns: readonly string[];
  resolvedTools: readonly string[];
}): string {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(input.displayName)) {
    throw new Error(
      'MCP capability display name cannot contain control characters.',
    );
  }
  const review = formatMcpCapabilityScopeReview(input);
  if (review.length > MCP_CAPABILITY_SCOPE_REVIEW_MAX_CHARS) {
    throw new Error(
      'MCP capability scope is too large to display completely. Request fewer or shorter tool patterns.',
    );
  }
  const redacted = redactSensitiveText(review);
  const sanitized = sanitizeOutboundLlmText(redacted);
  if (
    redacted !== review ||
    sanitized.redacted ||
    sanitized.blocked ||
    sanitized.text !== review
  ) {
    throw new Error(
      'MCP capability scope cannot be displayed safely and completely. Request explicit tool names that do not resemble sensitive material.',
    );
  }
  return review;
}
