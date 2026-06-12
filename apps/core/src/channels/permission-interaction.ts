import type {
  InteractionFile,
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
} from '../shared/agent-tool-references.js';
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
} from '../domain/permission-decision.js';
import { escapeMarkdownFenceDelimiters } from './permission-fenced-content.js';
import {
  formatPermissionToolInputLines,
  runtimeDisplayCommand,
} from './permission-tool-input-format.js';

export {
  decisionForMode,
  firstPersistentRule,
  persistentPermissionUpdates,
  persistentRules,
  TIMED_GRANT_DURATION_MS,
} from '../domain/permission-decision.js';

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

export function normalizePermissionAction(
  action: string,
): PermissionApprovalDecisionMode | null {
  if (action === 'allow_once') return 'allow_once';
  if (action === 'allow_persistent_rule') return 'allow_persistent_rule';
  if (action === 'allow_timed_grant') return 'allow_timed_grant';
  if (action === 'cancel') return 'cancel';
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
  return 'Allow for future';
}

export function formatPermissionPromptText(
  request: PermissionApprovalRequest,
  timeoutMs: number,
  options: { budget?: number } = {},
): string {
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  if (request.interaction) {
    return formatInteractionPermissionPrompt(
      request,
      timeoutMinutes,
      options.budget,
    );
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
  const lines = [`🔐 Allow ${label}?`];
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
  lines.push('', ...formatPermissionContextLines(request));
  lines.push(`Reply in ${timeoutMinutes}m`);
  return limitPermissionMessage(lines.join('\n'));
}

export function formatPermissionReceiptText(
  _requestId: string,
  request: PermissionApprovalRequest | undefined,
  decision: PermissionApprovalDecision,
): string {
  const summary = formatPermissionReceiptActionSummary(request);
  if (!decision.approved || decision.mode === 'cancel') {
    return limitPermissionMessage(`Canceled: ${summary}. Nothing changed.`);
  }
  if (decision.mode === 'allow_timed_grant') {
    const expiresAt = decision.timedGrantExpiresAtMs;
    const until = expiresAt
      ? new Date(expiresAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'soon';
    return limitPermissionMessage(
      `Allowed for 5 min: ${summary}. This expires at ${until}.`,
    );
  }
  if (decision.mode === 'allow_persistent_rule') {
    const agentName = request
      ? formatAgentDisplayName(request.sourceAgentFolder)
      : 'this agent';
    return limitPermissionMessage(
      `Allowed for future: ${summary}. Saved for ${agentName}. You can remove it from Agent Access.`,
    );
  }
  return limitPermissionMessage(
    `Allowed once: ${summary}. The agent will continue this request.`,
  );
}

export const PERMISSION_GLYPH = '🔐';

/**
 * Structured view of a permission prompt for provider-native renderers
 * (Slack blocks, Telegram HTML). The plain-text `formatPermissionPromptText`
 * above remains the canonical fallback; keep both in sync when fields change.
 */
export interface PermissionPromptParts {
  /** Title without the glyph, e.g. "Allow exact command access?" */
  title: string;
  /** Tool-input / field lines. May contain ``` fenced code regions. */
  bodyLines: string[];
  /** Dim metadata lines (agent · source, routing note). */
  contextLines: string[];
  replyInMinutes: number;
}

export function buildPermissionPromptParts(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): PermissionPromptParts {
  const replyInMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  const contextLines = formatPermissionContextLines(request);
  if (request.interaction) {
    const interaction = request.interaction;
    const rule = firstPersistentRule(request);
    const capabilityName = semanticCapabilityName(request, rule);
    const title = `Allow ${capabilityName ?? permissionAccessLabel(request)}?`;
    const bodyLines: string[] = [];
    const accountLabel = request.toolInput?.accountLabel;
    if (typeof accountLabel === 'string' && accountLabel.trim()) {
      bodyLines.push(
        `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
      );
    }
    if (interaction.body) {
      bodyLines.push(sanitizePermissionText(interaction.body, 500, 160));
    }
    if (interaction.details?.length) {
      bodyLines.push(
        ...interaction.details.map((detail) =>
          formatInteractionDetailLine(detail.label, detail.value, detail.mono),
        ),
      );
    }
    if (interaction.files?.length) {
      bodyLines.push(...formatInteractionFileLines(interaction.files));
    }
    return { title, bodyLines, contextLines, replyInMinutes };
  }
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  if (capabilityName) {
    const definition = semanticCapabilityDefinition(request, rule);
    const bodyLines: string[] = [];
    const accountLabel =
      definition?.accountLabel ?? request.toolInput?.accountLabel;
    if (typeof accountLabel === 'string' && accountLabel.trim()) {
      bodyLines.push(
        `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
      );
    }
    if (definition?.risk) {
      bodyLines.push(`Risk: ${humanizeIdentifier(definition.risk)}`);
    }
    const networkLine = semanticCapabilityNetworkLine(definition);
    if (networkLine) bodyLines.push(networkLine);
    return {
      title: `Allow ${capabilityName}?`,
      bodyLines,
      contextLines,
      replyInMinutes,
    };
  }
  const label = permissionAccessLabel(request);
  const bodyLines = formatPermissionToolInputLines(
    request,
    sanitizePermissionText,
    { sanitizeCommandText: sanitizePermissionCommandText },
  );
  if (request.blockedPath) {
    bodyLines.push(
      `Path: ${sanitizePermissionText(request.blockedPath, 250, 100)}`,
    );
  }
  return { title: `Allow ${label}?`, bodyLines, contextLines, replyInMinutes };
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
  if (result.blocked) {
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

function limitPermissionMessage(
  input: string,
  budget = PERMISSION_MESSAGE_BUDGET,
): string {
  if (input.length <= budget) return input;
  return `${input.slice(0, budget - 44)}\n\n[additional permission details omitted]`;
}

function formatPermissionContextLines(
  request: PermissionApprovalRequest | undefined,
): string[] {
  if (!request) return [];
  const context = request.jobId
    ? `scheduled job${request.jobName ? `: ${sanitizePermissionText(request.jobName, 120, 40)}` : ''}`
    : 'agent chat';
  const lines = [
    `Agent: ${formatAgentDisplayName(request.sourceAgentFolder)}`,
    `Context: ${context}`,
  ];
  if (requestHasThreadRoute(request)) {
    lines.push('Approval applies to the parent conversation.');
  }
  lines.push('The agent cannot approve this itself.');
  return lines;
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

function formatInteractionPermissionPrompt(
  request: PermissionApprovalRequest,
  timeoutMinutes: number,
  budget?: number,
): string {
  const interaction = request.interaction!;
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  const title = `🔐 Allow ${capabilityName ?? permissionAccessLabel(request)}?`;
  const lines = [title];
  const accountLabel = request.toolInput?.accountLabel;
  if (typeof accountLabel === 'string' && accountLabel.trim()) {
    lines.push(
      `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
    );
  }
  if (interaction.body)
    lines.push('', sanitizePermissionText(interaction.body, 500, 160));
  if (interaction.details?.length) {
    lines.push(
      '',
      ...interaction.details.map((detail) =>
        formatInteractionDetailLine(detail.label, detail.value, detail.mono),
      ),
    );
  }
  if (interaction.files?.length) {
    lines.push('', ...formatInteractionFileLines(interaction.files));
  }
  lines.push('', ...formatPermissionContextLines(request));
  lines.push(`Reply in ${timeoutMinutes}m`);
  return limitPermissionMessage(
    lines.join('\n'),
    budget ??
      (interaction.files?.some((file) => file.preview && !file.truncated)
        ? 6000
        : undefined),
  );
}

function formatSemanticPermissionPrompt(
  request: PermissionApprovalRequest,
  capabilityName: string,
  timeoutMinutes: number,
  rule: string | undefined,
): string {
  const definition = semanticCapabilityDefinition(request, rule);
  const lines = [`🔐 Allow ${capabilityName}?`];
  const accountLabel =
    definition?.accountLabel ?? request.toolInput?.accountLabel;
  if (typeof accountLabel === 'string' && accountLabel.trim()) {
    lines.push(
      `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
    );
  }
  if (definition?.risk) {
    lines.push(`Risk: ${humanizeIdentifier(definition.risk)}`);
  }
  const networkLine = semanticCapabilityNetworkLine(definition);
  if (networkLine) lines.push(networkLine);
  lines.push('', ...formatPermissionContextLines(request));
  lines.push(`Reply in ${timeoutMinutes}m`);
  return limitPermissionMessage(lines.join('\n'));
}

function semanticCapabilityNetworkLine(
  definition: SemanticCapabilityDefinition | undefined,
): string | undefined {
  const hosts = [
    ...new Set(
      (definition?.networkHosts ?? [])
        .map((host) => host.trim())
        .filter(Boolean),
    ),
  ];
  if (hosts.length === 0) return undefined;
  return `Network: ${sanitizePermissionText(hosts.join(', '), 200, 100)}`;
}

function formatInteractionDetailLine(
  label: string,
  value: string,
  mono?: boolean,
): string {
  const text = sanitizePermissionText(value, 200, 100);
  return `${label}: ${mono ? '`' : ''}${text}${mono ? '`' : ''}`;
}

function formatInteractionFileLines(files: InteractionFile[]): string[] {
  const lines: string[] = [];
  files.slice(0, 3).forEach((file, index) => {
    const path = sanitizePermissionText(file.path, 160, 60);
    const details = [
      typeof file.sizeBytes === 'number'
        ? formatApproxBytes(file.sizeBytes)
        : null,
      file.contentHash ? `sha256 ${file.contentHash.slice(0, 16)}` : null,
    ].filter(Boolean);
    lines.push(
      `Review file${files.length > 1 ? ` ${index + 1}` : ''}: ${path}${
        details.length > 0 ? ` (${details.join(', ')})` : ''
      }`,
    );
    if (file.preview && !file.truncated) {
      lines.push(
        'Full content:',
        '```markdown',
        escapeMarkdownFenceDelimiters(
          sanitizePermissionText(file.preview, file.preview.length, 0),
        ),
        '```',
      );
    } else if (file.preview) {
      lines.push(
        'Preview is truncated; review the full artifact before allowing.',
      );
    }
  });
  if (files.length > 3) lines.push(`+${files.length - 3} more review files`);
  return lines;
}

function formatApproxBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    const displayCommand = runtimeDisplayCommand(command);
    const generatedSkillPath = generatedRuntimeSkillPathDisplay(
      displayCommand.command,
    );
    if (generatedSkillPath) {
      const env = displayCommand.runtimeEnvAssignments.join(' ');
      const envSummary = env ? `; env: ${sanitizeReceiptDetail(env)}` : '';
      return `Selected skill action (${generatedSkillPath}${envSummary})`;
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
