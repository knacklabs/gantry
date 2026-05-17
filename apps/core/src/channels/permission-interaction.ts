import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { adminMcpToolNameFromFullName } from '../shared/admin-mcp-tools.js';
import {
  isCanonicalBrowserCapabilityRule,
  isThirdPartyMcpToolRule,
  parseReadableScopedToolRule,
} from '../shared/agent-tool-references.js';
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
  if (mode === 'allow_timed_grant') {
    return 'Allow 5 min';
  }
  if (mode === 'cancel') return 'Cancel';
  return 'Always allow';
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
  const label = permissionAccessLabel(request);
  const requestLabel = request.displayName || request.title;
  const lines = [
    `Allow ${label}?`,
    '',
    ...formatPermissionOriginLines(request),
  ];
  if (requestLabel) {
    lines.push(`Request: ${sanitizePermissionText(requestLabel, 160, 40)}`);
  }
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
    { sanitizeCommandText: sanitizePermissionCommandText },
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
    lines.push('', `Details: ${formatPersistentPermissionRulesForUser(rules)}`);
  }
  lines.push('', ...formatPermissionBoundaryLines(request));
  lines.push('', `Reply within ${timeoutMinutes} minute(s).`);
  return limitPermissionMessage(lines.join('\n'));
}

export function formatPermissionReceiptText(
  _requestId: string,
  request: PermissionApprovalRequest | undefined,
  decision: PermissionApprovalDecision,
): string {
  const actor = decision.decidedBy || 'unknown';
  const label = permissionAccessLabel(request);
  if (!decision.approved || decision.mode === 'cancel') {
    return limitPermissionMessage(
      [
        `Canceled: ${label}. No permission changed.`,
        ...formatPermissionOriginLines(request),
        `By: ${sanitizePermissionText(actor, 120, 40)}`,
      ].join('\n'),
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
        `Allowed for 5 minutes: ${label}`,
        `Until: ${expiresLabel}`,
        `For: ${formatPermissionReceiptActionSummary(request)}`,
        ...formatPermissionOriginLines(request),
        `By: ${sanitizePermissionText(actor, 120, 40)}`,
      ].join('\n'),
    );
  }
  if (decision.mode === 'allow_persistent_rule') {
    const rules = request ? persistentRules(request) : [];
    const lines = [`Always allowed: ${label}`];
    if (rules.length > 0) {
      lines.push(`Details: ${formatPersistentPermissionRulesForUser(rules)}`);
    }
    lines.push(`For: ${formatPermissionReceiptActionSummary(request)}`);
    lines.push(...formatPermissionOriginLines(request));
    lines.push(`By: ${sanitizePermissionText(actor, 120, 40)}`);
    lines.push('Revoke: /permissions remove <rule>');
    return limitPermissionMessage(lines.join('\n'));
  }
  return limitPermissionMessage(
    [
      `Allowed once: ${label}`,
      `For: ${formatPermissionReceiptActionSummary(request)}`,
      ...formatPermissionOriginLines(request),
      `By: ${sanitizePermissionText(actor, 120, 40)}`,
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
  const result = sanitizeOutboundLlmText(input);
  if (
    result.redacted ||
    result.blocked ||
    /\[REDACTED_(?:SECRET|POTENTIALLY_SENSITIVE)\]/.test(result.text)
  ) {
    return 'Sensitive detail hidden.';
  }
  return headTailTruncate(result.text, head, tail);
}

function sanitizePermissionCommandText(
  input: string,
  head: number,
  tail: number,
): string {
  return headTailTruncate(redactSensitiveText(input), head, tail);
}

function limitPermissionMessage(input: string): string {
  if (input.length <= PERMISSION_MESSAGE_BUDGET) return input;
  return `${input.slice(0, PERMISSION_MESSAGE_BUDGET - 44)}\n\n[additional permission details omitted]`;
}

function formatPermissionOriginLines(
  request: PermissionApprovalRequest | undefined,
): string[] {
  if (!request) return [];
  const source = request.jobId
    ? `scheduled job${request.jobName ? `: ${sanitizePermissionText(request.jobName, 120, 40)}` : ''}`
    : 'agent chat';
  return [
    `From: ${source}`,
    `Agent: ${sanitizePermissionText(request.sourceAgentFolder, 120, 40)}`,
  ];
}

function formatInteractionPermissionPrompt(
  request: PermissionApprovalRequest,
  timeoutMinutes: number,
): string {
  const interaction = request.interaction!;
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  const title = `Allow ${capabilityName ?? permissionAccessLabel(request)}?`;
  const lines = [title, ...formatPermissionOriginLines(request)];
  const accountLabel = request.toolInput?.accountLabel;
  if (typeof accountLabel === 'string' && accountLabel.trim()) {
    lines.push(
      `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
    );
  }
  if (interaction.body)
    lines.push('', sanitizePermissionText(interaction.body, 500, 160));
  lines.push('', ...formatPermissionBoundaryLines(request));
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
    ...formatPermissionOriginLines(request),
  ];
  const capabilityId =
    definition?.capabilityId ?? semanticCapabilityId(request, rule);
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
  const details = [
    capabilityId ? `capability:${capabilityId}` : undefined,
    definition?.risk ? `risk: ${definition.risk}` : undefined,
  ].filter((item): item is string => Boolean(item));
  if (details.length > 0) lines.push('', `Details: ${details.join('; ')}`);
  lines.push('', ...formatPermissionBoundaryLines(request));
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
      'Scope: this request or a short 5-minute grant.',
      'Safety: unrelated tools, secrets, settings changes, and protected paths are not included.',
    ];
  }
  if (capabilityName) {
    return [
      'Scope: this request, a short 5-minute grant, or future matching runs.',
      'Safety: unrelated apps, credentials, settings changes, and broader access are not included.',
    ];
  }
  return [
    'Scope: this request, a short 5-minute grant, or future matching tool calls.',
    'Safety: only matching future access is included; unrelated tools, secrets, and settings changes are not included.',
  ];
}

function permissionAccessLabel(
  request: PermissionApprovalRequest | undefined,
): string {
  if (!request) return 'permission request';
  const rule = firstPersistentRule(request);
  const scopedRule = rule ? parseReadableScopedToolRule(rule) : null;
  const requestedToolName = requestedToolNameFromInput(request);
  if (
    request.toolName === 'Bash' ||
    requestedToolName === 'Bash' ||
    scopedRule?.toolName === 'Bash'
  ) {
    return 'exact command access';
  }
  const capabilityName = semanticCapabilityName(request, rule);
  if (capabilityName) return capabilityName;
  const toolName =
    scopedRule?.toolName || requestedToolName || request.toolName;
  if (isCanonicalBrowserCapabilityRule(toolName)) return 'Browser';
  if (toolName.startsWith('mcp__myclaw__browser_')) return 'Browser';
  const adminName = adminMcpToolNameFromFullName(toolName);
  if (adminName) return `Gantry ${humanizeIdentifier(adminName)}`;
  if (isThirdPartyMcpToolRule(toolName)) {
    return `${humanizeMcpServerName(toolName)} MCP tool`;
  }
  const display = request.displayName || request.title || toolName;
  return sanitizePermissionText(display, 120, 40);
}

function requestedToolNameFromInput(
  request: PermissionApprovalRequest,
): string | undefined {
  const input = request.toolInput;
  if (!input || typeof input !== 'object') return undefined;
  const toolName = input.toolName;
  if (typeof toolName === 'string' && toolName.trim()) return toolName.trim();
  const toolNames = input.toolNames;
  if (Array.isArray(toolNames) && toolNames.length === 1) {
    const first = toolNames[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
  }
  return undefined;
}

function humanizeMcpServerName(toolName: string): string {
  const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
  return match?.[1] ? humanizeIdentifier(match[1]) : 'third-party';
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/^mcp__/, '')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
  if (rule) return undefined;
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
    return ruleId;
  }
  const fromContext = request.interaction?.requestContext?.capabilityId;
  if (fromContext) return fromContext;
  const fromInput = request.toolInput?.capabilityId;
  return typeof fromInput === 'string' && fromInput.trim()
    ? fromInput.trim()
    : undefined;
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

function formatPermissionReceiptActionSummary(
  request: PermissionApprovalRequest | undefined,
): string {
  if (!request) return 'permission request';
  const tool = request.displayName || request.toolName;
  const input = request.toolInput;
  if (!input || typeof input !== 'object') return tool;
  const command = permissionCommand(request);
  if (command) {
    const safeCommand = sanitizeReceiptDetail(command);
    return safeCommand ? `${tool} (${safeCommand})` : `${tool} command`;
  }
  const filePath = input.file_path;
  if (typeof filePath === 'string' && filePath.trim()) {
    const safePath = sanitizeReceiptDetail(filePath.trim());
    return safePath ? `${tool} (${safePath})` : `${tool} file action`;
  }
  const url = input.url;
  if (typeof url === 'string' && url.trim()) {
    const safeUrl = sanitizeReceiptDetail(url.trim());
    return safeUrl ? `${tool} (${safeUrl})` : `${tool} URL action`;
  }
  const pattern = input.pattern;
  if (typeof pattern === 'string' && pattern.trim()) {
    const safePattern = sanitizeReceiptDetail(pattern.trim());
    return safePattern ? `${tool} (${safePattern})` : `${tool} pattern action`;
  }
  return tool;
}

function sanitizeReceiptDetail(input: string): string | null {
  const result = sanitizeOutboundLlmText(input);
  if (result.redacted || result.blocked) return null;
  if (/\[REDACTED_(?:SECRET|POTENTIALLY_SENSITIVE)\]/.test(result.text)) {
    return null;
  }
  return headTailTruncate(result.text, 200, 100);
}
