import type { JobSetupAction } from '../job-types.js';
import type { PermissionAuthorityAddition } from '../permission-decision.js';

interface WireGrantRule {
  tool_name: string;
  rule_content?: string;
}

interface WireGrant {
  type: PermissionAuthorityAddition['type'];
  behavior: 'allow';
  rules: WireGrantRule[];
  destination?: PermissionAuthorityAddition['destination'];
}

// ONE complete snake_case wire shape (S2b): every external surface (events,
// API, SDK) uses this mapper - no camelCase leaks through nested grants.
export type JobSetupActionEventPayload =
  | { kind: 'approve_grant'; grant: WireGrant }
  | { kind: 'fix_proposal'; proposal_id: string }
  | { kind: 'instruction'; text: string };

export function jobSetupActionEventPayload(
  action: JobSetupAction,
): JobSetupActionEventPayload {
  if (action.kind === 'fix_proposal') {
    return { kind: 'fix_proposal', proposal_id: action.proposalId };
  }
  if (action.kind === 'instruction') {
    return { kind: 'instruction', text: action.text };
  }
  return {
    kind: 'approve_grant',
    grant: {
      type: action.grant.type,
      behavior: action.grant.behavior,
      rules: action.grant.rules.map((rule) => ({
        tool_name: rule.toolName,
        ...(rule.ruleContent !== undefined
          ? { rule_content: rule.ruleContent }
          : {}),
      })),
      ...(action.grant.destination
        ? { destination: action.grant.destination }
        : {}),
    },
  };
}

export function jobSetupActionFromEventPayload(
  payload: JobSetupActionEventPayload,
): JobSetupAction {
  if (payload.kind === 'fix_proposal') {
    return { kind: 'fix_proposal', proposalId: payload.proposal_id };
  }
  if (payload.kind === 'instruction') {
    return { kind: 'instruction', text: payload.text };
  }
  return {
    kind: 'approve_grant',
    grant: {
      type: payload.grant.type,
      behavior: payload.grant.behavior,
      rules: payload.grant.rules.map((rule) => ({
        toolName: rule.tool_name,
        ...(rule.rule_content !== undefined
          ? { ruleContent: rule.rule_content }
          : {}),
      })),
      ...(payload.grant.destination
        ? { destination: payload.grant.destination }
        : {}),
    },
  };
}
