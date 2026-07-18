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
} from '../shared/agent-tool-references.js';
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
import {
  buildPermissionPromptFullView,
  formatInteractionDetailLine as formatPromptInteractionDetailLine,
  formatInteractionFileLines as formatPromptInteractionFileLines,
  type PermissionPromptFullView,
} from './permission-full-view.js';

export {
  buildPermissionPromptFullView,
  type PermissionPromptFullView,
} from './permission-full-view.js';
import {
  formatPermissionAgentDisplayName,
  permissionPromptTitle,
} from './permission-agent-display.js';
import {
  formatPermissionToolInputLines,
  runtimeDisplayCommand,
} from './permission-tool-input-format.js';
import {
  limitPermissionMessage,
  sanitizePermissionCommandText,
  sanitizePermissionText,
  sanitizeReceiptDetail,
} from './permission-text-sanitizer.js';
import {
  decisionForPermissionInteraction,
  buildPermissionBatchPromptParts,
  formatPermissionBatchPromptText,
  isPermissionBatchRequest,
  permissionBatchButtonLabel,
  withRecoveredBatchOption,
} from './permission-batch-coalescer.js';

export {
  firstPersistentRule,
  persistentPermissionUpdates,
  persistentRules,
} from '../domain/permission-decision.js';
export { decisionForPermissionInteraction as decisionForMode };

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
  if (action === 'cancel') return 'cancel';
  return null;
}

export function permissionDecisionOptions(
  request: PermissionApprovalRequest,
  matchKind?: 'individual' | 'batch',
): PermissionApprovalDecisionMode[] {
  const rule = firstPersistentRule(request);
  const requested = request.decisionOptions;
  const fallback: PermissionApprovalDecisionMode[] = rule
    ? ['allow_once', 'allow_persistent_rule', 'cancel']
    : ['allow_once', 'cancel'];
  const options = requested?.length ? requested : fallback;
  if (!requested?.length && !rule) logOptionDrop(request);
  return withRecoveredBatchOption(options, matchKind);
}

function logOptionDrop(request: PermissionApprovalRequest): void {
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
  const batchLabel = permissionBatchButtonLabel(_request, mode);
  if (batchLabel) return batchLabel;
  if (mode === 'allow_once') return 'Allow once';
  if (mode === 'cancel') return 'Cancel';
  return 'Allow for future';
}

export function formatPermissionPromptText(
  request: PermissionApprovalRequest,
  timeoutMs: number,
  options: { budget?: number } = {},
): string {
  const batchText = formatPermissionBatchPromptText(request, timeoutMs);
  if (batchText) return limitPermissionMessage(batchText);
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
  const lines = [
    `🔐 ${permissionPromptTitle(request.sourceAgentFolder, label)}`,
  ];
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
  if (decision.mode === 'allow_persistent_rule') {
    if (decision.batchDecision === 'review_each')
      return 'Reviewing each permission request.';
    if (request && isPermissionBatchRequest(request))
      return 'Reviewing each permission request.';
    const agentName = request
      ? formatPermissionAgentDisplayName(request.sourceAgentFolder)
      : 'this agent';
    return limitPermissionMessage(
      `Allowed for future: ${summary}. Saved for ${agentName}. Manage access to revoke it later.`,
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
  fullView?: PermissionPromptFullView;
}

export function buildPermissionPromptParts(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): PermissionPromptParts {
  const batchParts = buildPermissionBatchPromptParts(request, timeoutMs);
  if (batchParts) return batchParts;
  const replyInMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  const contextLines = formatPermissionContextLines(request);
  const fullView = buildPermissionPromptFullView(request);
  if (request.interaction) {
    const interaction = request.interaction;
    const rule = firstPersistentRule(request);
    const capabilityName = semanticCapabilityName(request, rule);
    const title = permissionPromptTitle(
      request.sourceAgentFolder,
      capabilityName ?? permissionAccessLabel(request),
    );
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
          formatPromptInteractionDetailLine(
            detail.label,
            detail.value,
            detail.mono,
            sanitizePermissionText,
          ),
        ),
      );
    }
    if (interaction.files?.length) {
      bodyLines.push(
        ...formatPromptInteractionFileLines(
          interaction.files,
          sanitizePermissionText,
        ),
      );
    }
    return {
      title,
      bodyLines: fullView ? stripFullPayloadBodyLines(bodyLines) : bodyLines,
      contextLines,
      replyInMinutes,
      fullView,
    };
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
      title: permissionPromptTitle(request.sourceAgentFolder, capabilityName),
      bodyLines,
      contextLines,
      replyInMinutes,
      fullView,
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
  return {
    title: permissionPromptTitle(request.sourceAgentFolder, label),
    bodyLines: fullView ? stripFullPayloadBodyLines(bodyLines) : bodyLines,
    contextLines,
    replyInMinutes,
    fullView,
  };
}

export function formatPermissionPromptPartsText(
  parts: PermissionPromptParts,
): string {
  const lines = [`${PERMISSION_GLYPH} ${parts.title}`];
  if (parts.bodyLines.length > 0) lines.push('', ...parts.bodyLines);
  if (parts.contextLines.length > 0) lines.push('', ...parts.contextLines);
  lines.push(`Reply in ${parts.replyInMinutes}m`);
  return limitPermissionMessage(lines.join('\n'));
}

function stripFullPayloadBodyLines(lines: string[]): string[] {
  const stripped: string[] = [];
  // ponytail: buildPermissionPromptFullView carries exactly one payload (the
  // first untruncated file/command/diff), so strip only the first fenced block.
  // Multi-file previews 2..n stay inline rather than being silently dropped.
  let dropped = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      !dropped &&
      (line === 'Command:' ||
        line === 'Change:' ||
        line === 'Full content:' ||
        line === 'Proposed content:') &&
      lines[index + 1]?.startsWith('```')
    ) {
      dropped = true;
      index += 2;
      while (index < lines.length && !lines[index]?.startsWith('```')) {
        index += 1;
      }
      continue;
    }
    stripped.push(line);
  }
  return stripped;
}

function formatPermissionContextLines(
  request: PermissionApprovalRequest | undefined,
): string[] {
  if (!request) return [];
  const context = request.jobId
    ? `scheduled job${request.jobName ? `: ${sanitizePermissionText(request.jobName, 120, 40)}` : ''}`
    : 'agent chat';
  const lines = [
    `Agent: ${formatPermissionAgentDisplayName(request.sourceAgentFolder)}`,
    `Context: ${context}`,
  ];
  if (requestHasThreadRoute(request)) {
    lines.push('Approval applies to the parent conversation.');
  }
  if (request.promotionHintCount) {
    lines.push(
      `You've allowed me to do this ${request.promotionHintCount} times — want me to stop asking?`,
    );
  }
  lines.push('The agent cannot approve this itself.');
  return lines;
}

function formatInteractionPermissionPrompt(
  request: PermissionApprovalRequest,
  timeoutMinutes: number,
  budget?: number,
): string {
  const interaction = request.interaction!;
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  const title = `🔐 ${permissionPromptTitle(
    request.sourceAgentFolder,
    capabilityName ?? permissionAccessLabel(request),
  )}`;
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
        formatPromptInteractionDetailLine(
          detail.label,
          detail.value,
          detail.mono,
          sanitizePermissionText,
        ),
      ),
    );
  }
  if (interaction.files?.length) {
    lines.push(
      '',
      ...formatPromptInteractionFileLines(
        interaction.files,
        sanitizePermissionText,
      ),
    );
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
  const lines = [
    `🔐 ${permissionPromptTitle(request.sourceAgentFolder, capabilityName)}`,
  ];
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

export function formatPermissionReceiptActionSummary(
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
    // Same treatment as the prompt: host-injected env plumbing is dropped;
    // agent-supplied env stays part of what was allowed.
    const safeCommand = sanitizeReceiptDetail(
      [...displayCommand.runtimeEnvAssignments, displayCommand.command].join(
        ' ',
      ),
    );
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
