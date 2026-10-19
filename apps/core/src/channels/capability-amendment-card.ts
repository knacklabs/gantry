import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';

/**
 * Capability template amendment card copy (decision 0122): plain-language,
 * ability-terms body with the admin Allow once / Deny buttons. Kept out of
 * permission-interaction.ts so the shared prompt module stays a router.
 */
export function isCapabilityTemplateAmendmentRequest(
  request: PermissionApprovalRequest,
): boolean {
  return request.toolName === 'capability_template_amendment';
}

export function amendmentReceiptText(
  request: PermissionApprovalRequest | undefined,
  decision: PermissionApprovalDecision,
): string | null {
  if (!request || !isCapabilityTemplateAmendmentRequest(request)) return null;
  // Neutral on approve: the card settles when the human decides, but the
  // catalog update happens after — the follow-up message reports the real
  // outcome (applied / setup changed / job resumed).
  if (decision.approved) {
    return `Applying the fix for ${request.displayName ?? 'this capability'}…`;
  }
  // System outcomes (timeout, cancellation) are not human denials: the
  // proposal stays pending and the card may return — say so honestly.
  if (!decision.decidedBy || decision.decidedBy.startsWith('system')) {
    return `The fix for ${request.displayName ?? 'this capability'} wasn't decided. I'll ask again when it next comes up.`;
  }
  return `Denied the fix for ${request.displayName ?? 'this capability'}. Nothing changed.`;
}

export function amendmentPromptParts(
  request: PermissionApprovalRequest,
  input: {
    contextLines: string[];
    fullView: unknown;
    sanitize: (text: string, maxLen: number, maxWord: number) => string;
  },
): {
  title: string;
  bodyLines: string[];
  contextLines: string[];
  fullView: unknown;
} | null {
  if (!isCapabilityTemplateAmendmentRequest(request)) return null;
  return {
    title:
      request.interaction?.title ??
      request.title ??
      `Fix how ${request.displayName ?? 'this capability'} runs`,
    bodyLines: (request.interaction?.body ?? '')
      .split(/\n{2,}/)
      .map((line) => input.sanitize(line, 500, 160))
      .filter(Boolean),
    contextLines: input.contextLines,
    fullView: input.fullView,
  };
}
