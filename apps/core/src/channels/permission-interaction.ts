import { createHash } from 'node:crypto';

import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { formatPersistentPermissionRulesForUser } from '../shared/persistent-permission-rules.js';
import {
  redactSensitiveText,
  sanitizeOutboundLlmText,
} from '../shared/sensitive-material.js';
import {
  getBuiltinSemanticCapability,
  type SemanticCapabilityDefinition,
} from '../shared/semantic-capabilities.js';
import { parseSemanticCapabilityRule } from '../shared/semantic-capability-ids.js';
import {
  firstPersistentRule,
  PERSISTENT_RULE_APPROVAL_MAX_RULES,
  persistentPermissionUpdates,
  persistentRules,
} from './permission-decision.js';
import { formatPermissionToolInputLines } from './permission-tool-input-format.js';

export {
  decisionForMode,
  firstPersistentRule,
  persistentPermissionUpdates,
  persistentRules,
  TIMED_GRANT_DURATION_MS,
} from './permission-decision.js';

const PERMISSION_MESSAGE_BUDGET = 2800;

export type PermissionActionToken =
  | PermissionApprovalDecisionMode
  | 'approve'
  | 'deny';

export function normalizePermissionAction(
  action: string,
): PermissionApprovalDecisionMode | null {
  if (action === 'allow_once' || action === 'approve') return 'allow_once';
  if (action === 'allow_persistent_rule') return 'allow_persistent_rule';
  if (action === 'allow_timed_grant') return 'allow_timed_grant';
  if (action === 'cancel' || action === 'deny') return 'cancel';
  return null;
}

export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
): PermissionApprovalDecisionMode[] {
  if (request.decisionOptions?.length) return request.decisionOptions;
  const persistentRule = firstPersistentRule(request);
  if (!persistentRule) logPersistentOptionDrop(request);
  return persistentRule
    ? ['allow_once', 'allow_timed_grant', 'allow_persistent_rule', 'cancel']
    : ['allow_once', 'allow_timed_grant', 'cancel'];
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
  if (!candidates[0].rules?.length) return 'expected at least one rule';
  if (candidates[0].rules.length > PERSISTENT_RULE_APPROVAL_MAX_RULES) {
    return `expected at most ${PERSISTENT_RULE_APPROVAL_MAX_RULES} rules`;
  }
  return 'rule missing toolName';
}

export function permissionButtonLabel(
  mode: PermissionApprovalDecisionMode,
  request: PermissionApprovalRequest,
): string {
  if (mode === 'allow_once') return 'Allow once';
  if (mode === 'allow_timed_grant') return 'Allow 5 min for this tool';
  if (mode === 'cancel') return 'Cancel';
  const rule = firstPersistentRule(request);
  if (!rule) return 'Always allow';
  const capabilityName = semanticCapabilityName(request, rule);
  if (capabilityName) return 'Always allow for this agent';
  const rules = persistentRules(request);
  if (rules.length > 1) return `Always allow ${rules.length} rules`;
  return `Always allow ${headTailTruncate(rule, 24, 9)}`;
}

export function formatPermissionPromptText(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): string {
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  if (request.interaction) {
    return formatInteractionPermissionPrompt(request, timeoutMinutes);
  }
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  if (capabilityName) {
    return formatSemanticPermissionPrompt(
      request,
      capabilityName,
      timeoutMinutes,
      rule,
    );
  }
  const title =
    request.title || request.displayName || `${request.toolName} request`;
  const lines = [
    sanitizePermissionText(title, 160, 40),
    '',
    `Tool: ${request.displayName || request.toolName}`,
    `Agent: ${request.sourceAgentFolder}`,
  ];
  if (request.agentID || request.subagentType) {
    lines.push(
      `Delegated Agent: ${request.subagentType || 'generic'}${request.agentID ? ` (${request.agentID})` : ''}`,
    );
  }
  if (request.threadId)
    lines.push(`Thread: ${sanitizePermissionText(request.threadId, 60, 20)}`);
  const inputLines = formatPermissionToolInputLines(
    request,
    sanitizePermissionText,
  );
  if (inputLines.length > 0) lines.push('', ...inputLines);
  if (request.blockedPath)
    lines.push(
      `Path: ${sanitizePermissionText(request.blockedPath, 250, 100)}`,
    );
  if (request.decisionReason)
    lines.push(
      `Reason: ${sanitizePermissionText(request.decisionReason, 260, 100)}`,
    );
  const closestRule = formatClosestRuleLine(request);
  if (closestRule) lines.push(closestRule);
  if (request.description)
    lines.push(
      `Details: ${sanitizePermissionText(request.description, 260, 100)}`,
    );
  const rules = persistentRules(request);
  if (rules.length > 0) {
    lines.push(
      '',
      'Approving persistent will grant:',
      ...formatRuleList(rules),
    );
  }
  lines.push('', ...formatPermissionBoundaryLines(request));
  lines.push('', `Reply within ${timeoutMinutes} minute(s).`);
  return limitPermissionMessage(lines.join('\n'));
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
    return limitPermissionMessage(
      `Canceled: no permission changed\nAction: ${sanitizePermissionText(action, 160, 40)}\nBy: ${sanitizePermissionText(actor, 120, 40)}`,
    );
  }
  if (decision.mode === 'allow_timed_grant') {
    const expiresAt = decision.timedGrantExpiresAtMs;
    const expiresLabel = expiresAt
      ? new Date(expiresAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'soon';
    return limitPermissionMessage(
      [
        `Timed grant active until ${expiresLabel}`,
        `For tool: ${formatPermissionActionSummary(request)}`,
        `By: ${sanitizePermissionText(actor, 120, 40)}`,
        `Request ID: \`${sanitizePermissionText(requestId, 160, 40)}\``,
      ].join('\n'),
    );
  }
  if (decision.mode === 'allow_persistent_rule') {
    const rules = request ? persistentRules(request) : [];
    const lines = ['Persistent permission approval received'];
    if (rules.length > 0) {
      lines.push('Requested grants:');
      lines.push(...formatRuleList(rules));
    }
    lines.push(`For tool: ${formatPermissionActionSummary(request)}`);
    lines.push(`By: ${sanitizePermissionText(actor, 120, 40)}`);
    lines.push(
      'Applying persistent grants now; final success or failure will be reported separately.',
    );
    lines.push('If applied, revoke with: /permissions remove <rule>');
    lines.push(`Request ID: \`${sanitizePermissionText(requestId, 160, 40)}\``);
    return limitPermissionMessage(lines.join('\n'));
  }
  return limitPermissionMessage(
    [
      'Allowed once',
      `For tool: ${formatPermissionActionSummary(request)}`,
      `By: ${sanitizePermissionText(actor, 120, 40)}`,
      `Request ID: \`${sanitizePermissionText(requestId, 160, 40)}\``,
    ].join('\n'),
  );
}

function headTailTruncate(input: string, head: number, tail: number): string {
  if (input.length <= head + tail + 1) return input;
  return `${input.slice(0, head)}…${input.slice(-tail)}`;
}

function sanitizePermissionText(
  input: string,
  head: number,
  tail: number,
): string {
  return headTailTruncate(sanitizeOutboundLlmText(input).text, head, tail);
}

function limitPermissionMessage(input: string): string {
  if (input.length <= PERMISSION_MESSAGE_BUDGET) return input;
  return `${input.slice(0, PERMISSION_MESSAGE_BUDGET - 44)}\n\n[additional permission details omitted]`;
}

function formatRuleList(rules: string[]): string[] {
  const shown = rules
    .slice(0, 5)
    .map((rule) => `  • ${sanitizePermissionText(rule, 260, 100)}`);
  const remaining = rules.length - shown.length;
  return remaining > 0 ? [...shown, `  …and ${remaining} more`] : shown;
}

function formatInteractionPermissionPrompt(
  request: PermissionApprovalRequest,
  timeoutMinutes: number,
): string {
  const interaction = request.interaction!;
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  const title = capabilityName
    ? `Allow ${capabilityName}?`
    : sanitizePermissionText(interaction.title, 160, 40);
  const lines = [title, `Agent: ${request.sourceAgentFolder}`];
  const accountLabel = request.toolInput?.accountLabel;
  if (typeof accountLabel === 'string' && accountLabel.trim()) {
    lines.push(
      `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
    );
  }
  if (interaction.body)
    lines.push('', sanitizePermissionText(interaction.body, 500, 160));
  lines.push('', ...formatPermissionBoundaryLines(request));
  lines.push(...formatPermissionAdvancedDetails(request, rule));
  if (interaction.details?.length) {
    lines.push(
      '',
      'Details:',
      ...interaction.details.map((detail) =>
        formatInteractionDetailLine(detail.label, detail.value, detail.mono),
      ),
    );
  }
  lines.push(`Reply within ${timeoutMinutes} minute(s).`);
  return limitPermissionMessage(lines.join('\n'));
}

function formatSemanticPermissionPrompt(
  request: PermissionApprovalRequest,
  capabilityName: string,
  timeoutMinutes: number,
  rule: string | undefined,
): string {
  const definition = semanticCapabilityDefinition(request, rule);
  const lines = [
    `Allow ${capabilityName}?`,
    `Agent: ${request.sourceAgentFolder}`,
  ];
  const capabilityId =
    definition?.capabilityId ?? semanticCapabilityId(request, rule);
  if (capabilityId) lines.push(`Capability: capability:${capabilityId}`);
  if (definition?.risk) lines.push(`Risk: ${definition.risk}`);
  const accountLabel =
    definition?.accountLabel ?? request.toolInput?.accountLabel;
  if (typeof accountLabel === 'string' && accountLabel.trim()) {
    lines.push(
      `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
    );
  }
  const can = definition?.can ?? request.toolInput?.can;
  if (typeof can === 'string' && can.trim()) {
    lines.push('', `Allows: ${sanitizePermissionText(can.trim(), 300, 100)}`);
  }
  const cannot = definition?.cannot ?? request.toolInput?.cannot;
  if (typeof cannot === 'string' && cannot.trim()) {
    lines.push(
      `Does not allow: ${sanitizePermissionText(cannot.trim(), 300, 100)}`,
    );
  }
  lines.push('', ...formatPermissionBoundaryLines(request));
  lines.push(...formatPermissionAdvancedDetails(request, rule));
  lines.push(`Reply within ${timeoutMinutes} minute(s).`);
  return limitPermissionMessage(lines.join('\n'));
}

function formatInteractionDetailLine(
  label: string,
  value: string,
  mono?: boolean,
): string {
  const text = sanitizePermissionText(value, 200, 100);
  return `${label}: ${mono ? '`' : ''}${text}${mono ? '`' : ''}`;
}

function formatPermissionBoundaryLines(
  request: PermissionApprovalRequest,
): string[] {
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  if (!rule) {
    return [
      'What this changes: Allow once applies only to this tool call. Allow 5 min auto-approves additional calls to the same tool for 5 minutes.',
    ];
  }
  if (capabilityName) {
    return [
      'Choices: Allow once, Always allow for this agent, or Cancel.',
      'What this changes: Allow once applies only to this invocation.',
      `Always allow grants the named capability for matching future runs: ${capabilityName}.`,
      'What this does not allow: unrelated apps, credentials, settings edits, or access outside the capability.',
    ];
  }
  return [
    'What this changes: Allow once applies only to this tool call.',
    `Always allow applies ${persistentRules(request).length > 1 ? 'these rules' : 'this rule'} to matching future tool calls: ${persistentRules(request).join(', ')}`,
    'What this does not allow: unrelated tools, secrets, settings edits, or broader access outside the rule.',
  ];
}

function semanticCapabilityName(
  request: PermissionApprovalRequest,
  rule?: string,
): string | undefined {
  const fromInteraction =
    request.interaction?.requestContext?.capabilityDisplayName?.trim();
  const definition = semanticCapabilityDefinition(request, rule);
  if (definition) return definition.displayName;
  const capabilityId = semanticCapabilityId(request, rule);
  if (capabilityId) return capabilityId;
  if (fromInteraction) return sanitizePermissionText(fromInteraction, 120, 40);
  const fromInput = request.toolInput?.capabilityDisplayName;
  if (typeof fromInput === 'string' && fromInput.trim()) {
    return sanitizePermissionText(fromInput.trim(), 120, 40);
  }
  return undefined;
}

function semanticCapabilityDefinition(
  request: PermissionApprovalRequest,
  rule?: string,
): SemanticCapabilityDefinition | undefined {
  const capabilityId = semanticCapabilityId(request, rule);
  return capabilityId ? getBuiltinSemanticCapability(capabilityId) : undefined;
}

function semanticCapabilityId(
  request: PermissionApprovalRequest,
  rule?: string,
): string | undefined {
  if (rule) {
    const ruleId = parseSemanticCapabilityRule(rule);
    if (ruleId) return ruleId;
  }
  const fromContext = request.interaction?.requestContext?.capabilityId;
  if (fromContext) return fromContext;
  const fromInput = request.toolInput?.capabilityId;
  return typeof fromInput === 'string' && fromInput.trim()
    ? fromInput.trim()
    : undefined;
}

function formatPermissionAdvancedDetails(
  request: PermissionApprovalRequest,
  rule?: string,
): string[] {
  const details = [
    '',
    'Details:',
    `Request ID: ${request.requestId}`,
    `Raw tool: ${request.toolName}`,
  ];
  if (rule) details.push(`Raw rule: ${rule}`);
  const rules = persistentRules(request);
  if (rules.length > 1) details.push(`Raw rules: ${rules.join(', ')}`);
  const closestRule = formatClosestRuleLine(request);
  if (closestRule) details.push(closestRule);
  const command = permissionCommand(request);
  if (command) {
    details.push(
      `Command preview: \`${sanitizePermissionText(command, 200, 100)}\``,
      `Command hash: ${createHash('sha256').update(command).digest('hex')}`,
    );
  }
  const executablePath = request.toolInput?.executablePath;
  if (typeof executablePath === 'string' && executablePath.trim()) {
    details.push(
      `Executable: ${sanitizePermissionText(executablePath.trim(), 180, 60)}`,
    );
  }
  const executableVersion = request.toolInput?.executableVersion;
  if (typeof executableVersion === 'string' && executableVersion.trim()) {
    details.push(
      `Executable version: ${sanitizePermissionText(executableVersion.trim(), 100, 40)}`,
    );
  }
  const sandboxProfile = request.toolInput?.sandboxProfile;
  if (typeof sandboxProfile === 'string' && sandboxProfile.trim()) {
    details.push(
      `Sandbox: ${sanitizePermissionText(sandboxProfile.trim(), 120, 40)}`,
    );
  }
  return details;
}

function formatClosestRuleLine(
  request: PermissionApprovalRequest,
): string | undefined {
  return request.closestRule
    ? `Closest existing rule: ${formatPersistentPermissionRulesForUser([request.closestRule.rule])} (did not match: ${sanitizePermissionText(request.closestRule.reason, 220, 80)})`
    : undefined;
}
function permissionCommand(request: PermissionApprovalRequest): string | null {
  if (!request.toolInput) return null;
  const command = request.toolInput.command ?? request.toolInput.cmd;
  return typeof command === 'string' && command.trim() ? command.trim() : null;
}

function formatPermissionActionSummary(
  request: PermissionApprovalRequest | undefined,
): string {
  if (!request) return 'permission request';
  const tool = request.displayName || request.toolName;
  const input = request.toolInput;
  if (!input || typeof input !== 'object') return tool;
  const command = permissionCommand(request);
  if (command) {
    return `${tool} (${sanitizePermissionText(command, 200, 100)})`;
  }
  const filePath = input.file_path;
  if (typeof filePath === 'string' && filePath.trim()) {
    return `${tool} (${sanitizePermissionText(filePath.trim(), 200, 100)})`;
  }
  const url = input.url;
  if (typeof url === 'string' && url.trim()) {
    return `${tool} (${sanitizePermissionText(url.trim(), 200, 100)})`;
  }
  const pattern = input.pattern;
  if (typeof pattern === 'string' && pattern.trim()) {
    return `${tool} (${sanitizePermissionText(pattern.trim(), 200, 100)})`;
  }
  return tool;
}
