import { decisionForMode } from '../domain/permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import type { ToolPolicyDecision } from '../shared/tool-execution-policy-service.js';

export type DeterministicPermissionRails = (input: {
  request: PermissionApprovalRequest;
}) => PermissionApprovalDecision | undefined;

export interface CoordinatePermissionDecisionInput {
  request: PermissionApprovalRequest;
  hardDenyReason?: string;
  accessPreset?: 'full' | 'locked';
  fixedImageRestricted?: boolean;
  reviewedRuleDecision?:
    | ToolPolicyDecision
    | (() => Promise<ToolPolicyDecision | undefined>);
  deterministicRails?: DeterministicPermissionRails;
  tail: () => Promise<PermissionApprovalDecision>;
}

const noDeterministicRails: DeterministicPermissionRails = () => undefined;

export async function coordinatePermissionDecision(
  input: CoordinatePermissionDecisionInput,
): Promise<PermissionApprovalDecision> {
  if (input.hardDenyReason) {
    return denied(input.request, input.hardDenyReason, 'hard_deny');
  }
  if (input.accessPreset === 'locked') {
    return denied(
      input.request,
      'capability not provisioned: this agent runs with a locked access preset.',
      'locked_preset',
    );
  }
  if (input.fixedImageRestricted) {
    return denied(
      input.request,
      'capability not provisioned: this run uses a fixed authority image.',
      'fixed_image',
    );
  }
  const reviewedRuleDecision =
    typeof input.reviewedRuleDecision === 'function'
      ? await input.reviewedRuleDecision()
      : input.reviewedRuleDecision;
  if (reviewedRuleDecision?.status === 'allow') {
    return {
      ...decisionForMode(input.request, 'allow_once', 'reviewed_rule'),
      reason: reviewedRuleDecision.reason,
    };
  }
  if (reviewedRuleDecision) {
    input.request.decisionReason = reviewedRuleDecision.reason;
    input.request.closestRule = reviewedRuleDecision.closestRule;
  }
  const railDecision = (input.deterministicRails ?? noDeterministicRails)({
    request: input.request,
  });
  return railDecision ?? input.tail();
}

interface PermissionRunRestriction {
  hideAuthorityTools: boolean;
}

const permissionRunRestrictions = new Map<string, PermissionRunRestriction>();

export function registerPermissionRunRestriction(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
  hideAuthorityTools: boolean;
}): void {
  permissionRunRestrictions.set(restrictionKey(input), {
    hideAuthorityTools: input.hideAuthorityTools,
  });
}

export function permissionRunRestriction(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
}): PermissionRunRestriction | undefined {
  return permissionRunRestrictions.get(restrictionKey(input));
}

export function unregisterPermissionRunRestriction(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
}): void {
  permissionRunRestrictions.delete(restrictionKey(input));
}

function restrictionKey(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
}): string {
  return `${input.sourceAgentFolder}\u0000${input.responseKeyId}`;
}

function denied(
  request: PermissionApprovalRequest,
  reason: string,
  decidedBy: string,
): PermissionApprovalDecision {
  return {
    ...decisionForMode(request, 'cancel', decidedBy),
    reason,
  };
}
