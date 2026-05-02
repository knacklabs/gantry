import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';

export type PermissionDecisionAction =
  | 'approve_once'
  | 'approve_permanent'
  | 'reject'
  | 'approve'
  | 'deny';

export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
): Array<'approve_once' | 'approve_permanent' | 'reject'> {
  if (request.decisionOptions?.length) return request.decisionOptions;
  return ['approve_once', 'reject'];
}

export function normalizePermissionDecisionAction(
  action: PermissionDecisionAction,
): 'approve_once' | 'approve_permanent' | 'reject' {
  if (action === 'approve') return 'approve_once';
  if (action === 'deny') return 'reject';
  return action;
}

export function isPermissionDecisionAllowed(
  request: PermissionApprovalRequest,
  action: PermissionDecisionAction,
): boolean {
  return permissionDecisionOptions(request).includes(
    normalizePermissionDecisionAction(action),
  );
}

export function permissionApproveLabel(
  request: PermissionApprovalRequest,
  mode: 'approve_once' | 'approve_permanent',
): string {
  if (mode === 'approve_once') return 'Approve once';
  if (request.permissionRule?.broad) return 'Approve broad access';
  return 'Approve rule';
}

export function formatPermissionRequestText(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): string {
  const rule = request.permissionRule;
  const lines = [
    'Permission request',
    '',
    'Status: Pending',
    `Agent: ${request.sourceGroup}`,
    `Requested access: ${rule?.canonical ?? request.displayName ?? request.toolName}`,
    `Scope: ${request.approvalScope === 'persistent' ? 'Persistent for this agent' : 'Temporary for this action'}`,
  ];
  if (request.threadId) {
    lines.push(`Thread: ${request.threadId}`);
  }
  const actionSummary = toolInputSummary(request);
  if (actionSummary) {
    lines.push(`${actionSummary.label}: \`${actionSummary.value}\``);
  }
  if (rule) {
    lines.push(`Risk: ${rule.risk} - ${rule.riskReason}`);
    if (rule.examples.length > 0) {
      lines.push('', 'What this allows:');
      for (const example of rule.examples.slice(0, 3)) {
        lines.push(`- ${example}`);
      }
    }
    lines.push('', `What this does not allow: ${rule.boundary}`);
  }
  if (request.decisionReason) {
    lines.push('', `Reason: ${request.decisionReason}`);
  }
  if (request.description) {
    lines.push('', request.description);
  }
  lines.push(
    '',
    `Timeout: ${Math.round(timeoutMs / 1000)}s`,
    `Request ID: ${request.requestId}`,
  );
  return lines.join('\n');
}

function toolInputSummary(
  request: PermissionApprovalRequest,
): { label: string; value: string } | null {
  const input = request.toolInput;
  if (!input || typeof input !== 'object') return null;
  const candidates: Array<[string, unknown]> = [
    ['Command', input.command],
    ['Path', input.file_path ?? input.path],
    ['URL', input.url],
    ['Prompt', input.prompt],
    ['Tool input', input.input ?? input.arguments],
  ];
  for (const [label, value] of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return { label, value: value.trim().slice(0, 500) };
    }
    if (value && typeof value === 'object') {
      return { label, value: JSON.stringify(value).slice(0, 500) };
    }
  }
  return null;
}

export function formatPermissionReceiptText(
  request: PermissionApprovalRequest,
  decision: PermissionApprovalDecision,
): string {
  const access =
    request.permissionRule?.canonical ??
    request.displayName ??
    request.toolName;
  const actor = decision.decidedBy ? ` by ${decision.decidedBy}` : '';
  if (!decision.approved) {
    if (decision.reason?.toLowerCase().includes('timed out')) {
      return `Expired without approval: ${access}. No persistent permission changed.`;
    }
    return `Rejected this request: ${access}${actor}. ${decision.reason || 'No persistent permission changed.'}`;
  }
  if (decision.mode === 'approve_permanent') {
    return `Approved permanently: ${access}${actor}. Applying persistent permission update.`;
  }
  return `Approved once: ${access}${actor}. This action was allowed without changing persistent permissions.`;
}
