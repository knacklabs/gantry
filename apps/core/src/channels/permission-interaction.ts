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
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from '../shared/agent-tool-references.js';
import { formatPersistentPermissionRulesForUser } from '../shared/persistent-permission-rules.js';
import { deliveryLabel } from './provider-delivery-labels.js';
import {
  redactSensitiveText,
  sanitizeOutboundLlmText,
} from '../shared/sensitive-material.js';
import { generatedRuntimeSkillPathDisplay } from '../shared/generated-runtime-paths.js';
import {
  skillActionCapabilityDisplayName,
  type SemanticCapabilityDefinition,
} from '../shared/semantic-capabilities.js';
import { parseSemanticCapabilityRule } from '../shared/semantic-capability-ids.js';
import {
  firstPersistentRule,
  PERSISTENT_RULE_APPROVAL_MAX_RULES,
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
const USER_FACING_TOOL_LABELS: Record<string, string> = {
  RunCommand: 'exact command access',
  Bash: 'exact command access',
  Browser: 'Browser',
  WebSearch: 'web search',
  WebRead: 'web page access',
  WebFetch: 'web page access',
  FileSearch: 'file search',
  Glob: 'file search',
  Grep: 'file search',
  FileRead: 'file reading',
  Read: 'file reading',
  FileEdit: 'file editing',
  Edit: 'file editing',
  MultiEdit: 'file editing',
  FileWrite: 'file writing',
  Write: 'file writing',
  AgentDelegation: 'agent delegation',
  Agent: 'agent delegation',
  Task: 'agent delegation',
};

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
  _request: PermissionApprovalRequest,
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
    ...formatPermissionRoutingLines(request),
  ];
  if (requestLabel) {
    lines.push(`Request: ${formatPermissionRequestLabel(requestLabel)}`);
  }
  if (request.agentID || request.subagentType) {
    lines.push(
      `Delegated Agent: ${request.subagentType || 'generic'}${request.agentID ? ` (${request.agentID})` : ''}`,
    );
  }
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
    lines.push(`Reason: ${formatPermissionReason(request.decisionReason)}`);
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
      `Details: ${formatPersistentPermissionRulesForUser(rules, {
        semanticCapabilityDefinitions: request.semanticCapabilityDefinitions,
      })}`,
    );
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
        ...formatPermissionRoutingLines(request),
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
    const scope = requestHasThreadRoute(request)
      ? ' in parent conversation'
      : '';
    return limitPermissionMessage(
      [
        `Allowed for 5 minutes${scope}: ${label}`,
        `Until: ${expiresLabel}`,
        `For: ${formatPermissionReceiptActionSummary(request)}`,
        ...formatPermissionOriginLines(request),
        ...formatPermissionRoutingLines(request),
        `By: ${sanitizePermissionText(actor, 120, 40)}`,
      ].join('\n'),
    );
  }
  if (decision.mode === 'allow_persistent_rule') {
    const rules = request ? persistentRules(request) : [];
    const agent = request
      ? formatAgentDisplayName(request.sourceAgentFolder)
      : 'this agent';
    const lines = [`Always allowed for ${agent}: ${label}`];
    if (rules.length > 0) {
      lines.push(
        `Details: ${formatPersistentPermissionRulesForUser(rules, {
          semanticCapabilityDefinitions: request?.semanticCapabilityDefinitions,
        })}`,
      );
    }
    lines.push(`For: ${formatPermissionReceiptActionSummary(request)}`);
    lines.push(...formatPermissionOriginLines(request));
    lines.push(...formatPermissionRoutingLines(request));
    lines.push(`By: ${sanitizePermissionText(actor, 120, 40)}`);
    lines.push('Revoke from Agent Access.');
    return limitPermissionMessage(lines.join('\n'));
  }
  return limitPermissionMessage(
    [
      `Allowed once: ${label}`,
      `For: ${formatPermissionReceiptActionSummary(request)}`,
      ...formatPermissionOriginLines(request),
      ...formatPermissionRoutingLines(request),
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
    `Agent: ${formatAgentDisplayName(request.sourceAgentFolder)}`,
    `From: ${source}`,
  ];
}

function formatAgentDisplayName(sourceAgentFolder: string): string {
  const sanitized = sanitizePermissionText(sourceAgentFolder, 120, 40).trim();
  if (!sanitized) return 'this agent';
  const withoutPrefix = sanitized.replace(/^agent:/i, '');
  const words = withoutPrefix
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!words) return 'this agent';
  return words
    .split(' ')
    .map((word) =>
      /^[A-Z0-9]+$/.test(word)
        ? word
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(' ');
}

function formatPermissionRoutingLines(
  request: PermissionApprovalRequest | undefined,
): string[] {
  if (!requestHasThreadRoute(request)) return [];
  const label = deliveryLabel(request?.targetJid ?? '', request?.threadId);
  return [
    `Route: shown in this ${label}; approval applies to the parent conversation.`,
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
  const lines = [
    title,
    ...formatPermissionOriginLines(request),
    ...formatPermissionRoutingLines(request),
  ];
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
    ...formatPermissionRoutingLines(request),
    `Access: ${sanitizePermissionText(capabilityName, 120, 40)}`,
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
  if (definition?.risk) {
    lines.push('', `Risk: ${humanizeIdentifier(definition.risk)}`);
  } else if (capabilityId) {
    lines.push('', `Capability: ${humanizeIdentifier(capabilityId)}`);
  }
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
  const hasThreadRoute = requestHasThreadRoute(request);
  if (!rule) {
    if (hasThreadRoute) {
      return [
        'Scope: this request or a short 5-minute grant in the parent conversation.',
        'Safety: unrelated tools, secrets, settings changes, and protected paths are not included.',
      ];
    }
    return [
      'Scope: this request or a short 5-minute grant.',
      'Safety: unrelated tools, secrets, settings changes, and protected paths are not included.',
    ];
  }
  if (capabilityName) {
    if (hasThreadRoute) {
      return [
        'Scope: this request, a short 5-minute grant, or always allow future matching runs in the parent conversation.',
        'Safety: unrelated apps, credentials, settings changes, and broader access are not included.',
      ];
    }
    return [
      'Scope: this request, a short 5-minute grant, or future matching runs.',
      'Safety: unrelated apps, credentials, settings changes, and broader access are not included.',
    ];
  }
  if (hasThreadRoute) {
    return [
      'Scope: this request, a short 5-minute grant, or always allow future matching tool calls in the parent conversation.',
      'Safety: only matching future access is included; unrelated tools, secrets, and settings changes are not included.',
    ];
  }
  return [
    'Scope: this request, a short 5-minute grant, or future matching tool calls.',
    'Safety: only matching future access is included; unrelated tools, secrets, and settings changes are not included.',
  ];
}

function requestHasThreadRoute(
  request: PermissionApprovalRequest | undefined,
): boolean {
  return (
    typeof request?.threadId === 'string' && request.threadId.trim() !== ''
  );
}

function permissionAccessLabel(
  request: PermissionApprovalRequest | undefined,
): string {
  if (!request) return 'permission request';
  const rule = firstPersistentRule(request);
  const semanticRuleId = rule ? parseSemanticCapabilityRule(rule) : undefined;
  const capabilityName = semanticCapabilityName(request, rule);
  if (
    capabilityName &&
    (semanticRuleId || request.interaction?.requestContext?.capabilityId)
  ) {
    return capabilityName;
  }
  const scopedRule = rule ? parseReadableScopedToolRule(rule) : null;
  const requestedToolName = requestedToolNameFromInput(request);
  if (permissionCommand(request)) {
    return 'exact command access';
  }
  if (capabilityName) return capabilityName;
  const toolName =
    scopedRule?.toolName || requestedToolName || request.toolName;
  const toolLabel = userFacingToolLabel(toolName);
  if (toolLabel) return toolLabel;
  const display = request.displayName || request.title || toolName;
  return formatPermissionRequestLabel(display);
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
    .replaceAll(/[._-]+/g, ' ')
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
  if (!capabilityId && rule) return undefined;
  if (capabilityId?.startsWith('skill.')) return undefined;
  if (fromInteraction) return sanitizePermissionText(fromInteraction, 120, 40);
  const fromInput = request.toolInput?.capabilityDisplayName;
  if (typeof fromInput === 'string' && fromInput.trim()) {
    return sanitizePermissionText(fromInput.trim(), 120, 40);
  }
  if (capabilityId) {
    return skillActionCapabilityDisplayName(capabilityId) ?? capabilityId;
  }
  return undefined;
}

function semanticCapabilityDefinition(
  request: PermissionApprovalRequest,
  rule?: string,
): SemanticCapabilityDefinition | undefined {
  const capabilityId = semanticCapabilityId(request, rule);
  if (!capabilityId) return undefined;
  return request.semanticCapabilityDefinitions?.[capabilityId];
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
    ? `Closest existing access: ${formatPersistentPermissionRulesForUser([request.closestRule.rule], { semanticCapabilityDefinitions: request.semanticCapabilityDefinitions })} (did not match: ${formatPermissionReason(request.closestRule.reason)})`
    : undefined;
}

function formatPermissionReason(reason: string): string {
  return neutralizeImplementationTerms(
    sanitizePermissionText(reason, 260, 100),
  );
}

function formatPermissionRequestLabel(label: string): string {
  const trimmed = label.trim();
  const toolLabel = userFacingToolLabel(trimmed);
  if (toolLabel) return humanizeIdentifier(toolLabel);
  return neutralizeImplementationTerms(
    sanitizePermissionText(trimmed, 160, 40),
  );
}

function neutralizeImplementationTerms(input: string): string {
  let text = input
    .replaceAll('simple_expansion', 'shell expansion')
    .replaceAll('Bash leaf', 'command');
  for (const [technical, label] of Object.entries(USER_FACING_TOOL_LABELS)) {
    text = text.replaceAll(technical, label);
  }
  return text;
}

function userFacingToolLabel(toolName: string | undefined): string | undefined {
  const publicName = publicGantryToolNameForSdkTool(toolName?.trim() ?? '');
  if (!publicName) return undefined;
  const label = USER_FACING_TOOL_LABELS[publicName];
  if (label) return label;
  if (isCanonicalBrowserCapabilityRule(publicName)) return 'Browser';
  if (publicName.startsWith('mcp__gantry__browser_')) return 'Browser';
  const adminName = adminMcpToolNameFromFullName(publicName);
  if (adminName) return `Gantry ${humanizeIdentifier(adminName)}`;
  if (isThirdPartyMcpToolRule(publicName)) {
    return `${humanizeMcpServerName(publicName)} tool access`;
  }
  return undefined;
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
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  if (capabilityName) return capabilityName;
  const tool =
    request.displayName ||
    request.title ||
    userFacingToolLabel(request.toolName);
  const input = request.toolInput;
  if (!input || typeof input !== 'object') {
    return tool ? formatPermissionRequestLabel(tool) : 'permission request';
  }
  const command = permissionCommand(request);
  if (command) {
    const generatedSkillPath = generatedRuntimeSkillPathDisplay(command);
    if (generatedSkillPath) {
      return `Selected skill action (${generatedSkillPath})`;
    }
    const safeCommand = sanitizeReceiptDetail(command);
    return safeCommand ? `Command (${safeCommand})` : 'Command';
  }
  const filePath = input.file_path;
  if (typeof filePath === 'string' && filePath.trim()) {
    const safePath = sanitizeReceiptDetail(filePath.trim());
    return safePath ? `File action (${safePath})` : 'File action';
  }
  const url = input.url;
  if (typeof url === 'string' && url.trim()) {
    const safeUrl = sanitizeReceiptDetail(url.trim());
    return safeUrl ? `Web action (${safeUrl})` : 'Web action';
  }
  const pattern = input.pattern;
  if (typeof pattern === 'string' && pattern.trim()) {
    const safePattern = sanitizeReceiptDetail(pattern.trim());
    return safePattern ? `Pattern action (${safePattern})` : 'Pattern action';
  }
  return tool
    ? sanitizePermissionText(humanizeIdentifier(tool), 120, 40)
    : 'permission request';
}

function sanitizeReceiptDetail(input: string): string | null {
  const result = sanitizeOutboundLlmText(input);
  if (result.redacted || result.blocked) return null;
  if (/\[REDACTED_(?:SECRET|POTENTIALLY_SENSITIVE)\]/.test(result.text)) {
    return null;
  }
  return headTailTruncate(result.text, 200, 100);
}
