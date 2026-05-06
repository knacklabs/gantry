import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';

export type PermissionActionToken =
  | PermissionApprovalDecisionMode
  | 'approve'
  | 'deny';

export function normalizePermissionAction(
  action: string,
): PermissionApprovalDecisionMode | null {
  if (action === 'allow_once' || action === 'approve') return 'allow_once';
  if (action === 'allow_job_policy') return 'allow_job_policy';
  if (action === 'allow_persistent_rule') return 'allow_persistent_rule';
  if (action === 'cancel' || action === 'deny') return 'cancel';
  return null;
}

export function persistentPermissionUpdates(
  request: PermissionApprovalRequest,
): PermissionApprovalUpdate[] {
  const candidates = (request.suggestions || []).filter(
    (update) =>
      (update.type === 'addRules' || update.type === 'replaceRules') &&
      update.behavior === 'allow' &&
      Array.isArray(update.rules) &&
      update.rules.length > 0,
  );
  if (candidates.length !== 1 || candidates[0].rules?.length !== 1) {
    return [];
  }
  return candidates;
}

export function firstPersistentRule(
  request: PermissionApprovalRequest,
): string | undefined {
  const [update] = persistentPermissionUpdates(request);
  const [rule] = update?.rules || [];
  if (!rule?.toolName) return undefined;
  return rule.ruleContent
    ? `${rule.toolName}(${rule.ruleContent})`
    : rule.toolName;
}

export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
): PermissionApprovalDecisionMode[] {
  if (request.decisionOptions?.length) return request.decisionOptions;
  const persistentRule = firstPersistentRule(request);
  if (!persistentRule) logPersistentOptionDrop(request);
  return persistentRule
    ? ['allow_once', 'allow_persistent_rule', 'cancel']
    : ['allow_once', 'cancel'];
}

function logPersistentOptionDrop(request: PermissionApprovalRequest): void {
  const suggestions = request.suggestions || [];
  if (suggestions.length === 0) return;
  logger.debug(
    {
      requestId: request.requestId,
      toolName: request.toolName,
      suggestionCount: suggestions.length,
      reason: persistentOptionDropReason(request),
    },
    'Persistent permission option unavailable',
  );
}

function persistentOptionDropReason(
  request: PermissionApprovalRequest,
): string {
  const candidates = (request.suggestions || []).filter(
    (update) =>
      (update.type === 'addRules' || update.type === 'replaceRules') &&
      update.behavior === 'allow' &&
      Array.isArray(update.rules) &&
      update.rules.length > 0,
  );
  if (candidates.length !== 1) return 'expected exactly one allow rule update';
  if (candidates[0].rules?.length !== 1) return 'expected exactly one rule';
  return 'rule missing toolName';
}

export function permissionButtonLabel(
  mode: PermissionApprovalDecisionMode,
  request: PermissionApprovalRequest,
): string {
  if (mode === 'allow_once') return 'Allow once';
  if (mode === 'allow_job_policy') return 'Store on this job';
  if (mode === 'cancel') return 'Cancel';
  const rule = firstPersistentRule(request);
  if (!rule) return 'Always allow';
  return isBroadPermissionRule(rule)
    ? 'Always allow broad access'
    : `Always allow ${truncateText(rule, 34)}`;
}

export function decisionForMode(
  request: PermissionApprovalRequest,
  mode: PermissionApprovalDecisionMode,
  decidedBy?: string,
): PermissionApprovalDecision {
  if (mode === 'cancel') {
    return {
      approved: false,
      mode,
      decidedBy,
      reason: 'canceled',
      decisionClassification: 'user_reject',
    };
  }
  if (mode === 'allow_persistent_rule') {
    const updates = persistentPermissionUpdates(request).map((update) => ({
      ...update,
      destination: 'session' as const,
    }));
    if (updates.length === 0) {
      return {
        approved: false,
        mode: 'cancel',
        decidedBy,
        reason: 'persistent rule unavailable',
        decisionClassification: 'user_reject',
      };
    }
    return {
      approved: true,
      mode,
      decidedBy,
      reason: 'persistent rule allowed',
      updatedPermissions: updates,
      decisionClassification: 'user_permanent',
    };
  }
  if (mode === 'allow_job_policy') {
    return {
      approved: true,
      mode,
      decidedBy,
      reason: 'job-scoped policy approved',
      decisionClassification: 'user_permanent',
    };
  }
  return {
    approved: true,
    mode,
    decidedBy,
    reason: 'allowed once',
    decisionClassification: 'user_temporary',
  };
}

export function formatPermissionPromptText(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): string {
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  const title =
    request.title || request.displayName || `${request.toolName} request`;
  const lines = [
    'Permission request',
    `Action: ${title}`,
    `Tool: ${request.displayName || request.toolName}`,
    `Agent: ${request.sourceAgentFolder}`,
  ];
  if (request.agentID || request.subagentType) {
    lines.push(
      `Delegated Agent: ${request.subagentType || 'generic'}${request.agentID ? ` (${request.agentID})` : ''}`,
    );
  }
  if (request.threadId)
    lines.push(`Thread: ${truncateText(request.threadId, 80)}`);
  const rule = firstPersistentRule(request);
  if (rule) lines.push(`Persistent rule option: ${rule}`);
  if (request.blockedPath) lines.push(`Path: ${request.blockedPath}`);
  if (request.decisionReason) lines.push(`Reason: ${request.decisionReason}`);
  if (request.description) lines.push(`Details: ${request.description}`);
  lines.push(...formatPermissionToolInputLines(request));
  lines.push(...formatPermissionBoundaryLines(request));
  lines.push(`Reply timeout: ${timeoutMinutes} minute(s)`);
  return lines.join('\n');
}

export function formatPermissionReceiptText(
  requestId: string,
  request: PermissionApprovalRequest | undefined,
  decision: PermissionApprovalDecision,
): string {
  const actor = decision.decidedBy || 'unknown';
  const action = request
    ? request.displayName || request.title || request.toolName
    : 'permission request';
  if (!decision.approved || decision.mode === 'cancel') {
    return `Canceled: no permission changed\nAction: ${action}\nBy: ${actor}`;
  }
  if (decision.mode === 'allow_persistent_rule') {
    const rule = request ? firstPersistentRule(request) : undefined;
    return `Allowed persistent rule: ${rule || action}\nBy: ${actor}\nRequest ID: ${requestId}`;
  }
  return `Allowed once: ${action}\nBy: ${actor}\nRequest ID: ${requestId}`;
}

export function truncateText(input: string, maxLength: number): string {
  return input.length <= maxLength
    ? input
    : `${input.slice(0, maxLength - 1)}…`;
}

function formatPermissionToolInputLines(
  request: PermissionApprovalRequest,
): string[] {
  if (!request.toolInput || typeof request.toolInput !== 'object') return [];
  const input = request.toolInput;
  if (
    request.toolName === 'Bash' &&
    typeof input.command === 'string' &&
    input.command.trim()
  ) {
    return [`Command: \`${truncateText(input.command.trim(), 300)}\``];
  }
  if (request.toolName === 'Edit' || request.toolName === 'Write') {
    const lines: string[] = [];
    if (typeof input.file_path === 'string' && input.file_path.trim()) {
      lines.push(`File: ${truncateText(input.file_path.trim(), 250)}`);
    }
    if (typeof input.old_string === 'string' && input.old_string.trim()) {
      lines.push(`Replacing: ${truncateText(input.old_string.trim(), 150)}`);
    }
    if (typeof input.new_string === 'string' && input.new_string.trim()) {
      lines.push(`With: ${truncateText(input.new_string.trim(), 150)}`);
    }
    if (lines.length > 0) return lines;
  }
  try {
    return [`Input: ${truncateText(JSON.stringify(input), 300)}`];
  } catch {
    return ['Input: [unserializable]'];
  }
}

function formatPermissionBoundaryLines(
  request: PermissionApprovalRequest,
): string[] {
  const rule = firstPersistentRule(request);
  if (!rule) {
    return ['What this changes: Allow once applies only to this tool call.'];
  }
  return [
    'What this changes: Allow once applies only to this tool call.',
    `Always allow applies this rule to matching future tool calls: ${rule}`,
    'What this does not allow: unrelated tools, secrets, settings edits, or broader access outside the rule.',
  ];
}

function isBroadPermissionRule(rule: string): boolean {
  const trimmed = rule.trim();
  const match = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(trimmed);
  if (!match) return false;
  const content = match[2]?.trim();
  if (content === undefined) return true;
  return /(^|[/\\])\*\*($|[/\\])|^\*$|^\.\*$|^\/?\*\*$/.test(content);
}
