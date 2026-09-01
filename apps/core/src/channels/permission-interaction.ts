import {
  amendmentButtonLabel,
  amendmentPromptParts,
  amendmentReceiptText,
} from './capability-amendment-card.js';
import { USER_FACING_TOOL_LABELS } from './permission-tool-labels.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { adminMcpToolNameFromFullName } from '../shared/admin-mcp-tools.js';
import {
  isCanonicalBrowserCapabilityRule,
  isThirdPartyMcpToolRule,
  parseReadableScopedToolRule,
  publicGantryToolNameForSdkTool,
} from '../shared/agent-tool-references.js';
import { generatedRuntimeSkillPathDisplay } from '../shared/generated-runtime-paths.js';
import {
  isMcpCapabilityProposalRequest,
  skillActionCapabilityDisplayName,
  type SemanticCapabilityDefinition,
} from '../shared/semantic-capabilities.js';
import { parseSemanticCapabilityRule } from '../shared/semantic-capability-ids.js';
import { firstPersistentRule } from '../domain/permission-decision.js';
import { isFamilyRunCommandRule } from '../shared/family-rule-synthesis.js';
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
  permissionRiskLines,
  runtimeDisplayCommand,
} from './permission-tool-input-format.js';
import {
  limitPermissionMessage,
  sanitizePermissionCommandText,
  sanitizePermissionText,
  sanitizeReceiptDetail,
} from './permission-text-sanitizer.js';
import { permissionPromptWaitLine } from './permission-prompt-wait-line.js';
import {
  decisionForPermissionInteraction,
  buildPermissionBatchPromptParts,
  formatPermissionBatchPromptText,
  isPermissionBatchRequest,
  permissionBatchButtonLabel,
} from './permission-batch-coalescer.js';
export {
  normalizePermissionAction,
  permissionDecisionOptions,
} from './permission-decision-options.js';

export {
  firstPersistentRule,
  persistentPermissionUpdates,
  persistentRules,
} from '../domain/permission-decision.js';
export { decisionForPermissionInteraction as decisionForMode };

export function permissionButtonLabel(
  mode: PermissionApprovalDecisionMode,
  _request: PermissionApprovalRequest,
): string {
  const amendmentLabel = amendmentButtonLabel(_request, mode);
  if (amendmentLabel) return amendmentLabel;
  const batchLabel = permissionBatchButtonLabel(_request, mode);
  if (batchLabel) return batchLabel;
  if (mode === 'allow_once')
    return isMcpCapabilityProposal(_request)
      ? 'Allow once (no access)'
      : 'Allow once';
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
  const title = permissionPromptTitle(request.sourceAgentFolder, label);
  const lines = [`🔐 ${title}`, ...permissionRiskLines(request)];
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
  const familyScopeLine = familyScopeCoverageLine(request);
  if (familyScopeLine) lines.push(familyScopeLine);
  lines.push('', ...formatPermissionContextLines(request));
  lines.push(permissionPromptWaitLine(Boolean(request.jobId), timeoutMinutes));
  return limitPermissionMessage(lines.join('\n'));
}

export function formatPermissionReceiptText(
  _requestId: string,
  request: PermissionApprovalRequest | undefined,
  decision: PermissionApprovalDecision,
): string {
  const summary = formatPermissionReceiptActionSummary(request); // Existing-prompt settlement, not a new chat receipt.
  const amendmentReceipt = amendmentReceiptText(request, decision);
  if (amendmentReceipt) return amendmentReceipt;
  if (!decision.approved || decision.mode === 'cancel') {
    return limitPermissionMessage(`Canceled: ${summary}. Nothing changed.`);
  }
  if (decision.batchDecision === 'review_each')
    return 'Reviewing each permission request.';
  // Strict field read, no mode fallback: decisionForMode always stamps
  // provenance (owner-directed no-legacy policy).
  if (decision.repeatableForFutureRuns === true) {
    const agentName = request
      ? formatPermissionAgentDisplayName(request.sourceAgentFolder)
      : 'this agent';
    return limitPermissionMessage(
      `Allowed for future: ${summary}. Saved for ${agentName}. Manage access to revoke it later.`,
    );
  }
  if (isMcpCapabilityProposal(request)) {
    return limitPermissionMessage(
      `No MCP access granted: ${summary}. MCP action authority requires Allow for future; nothing changed.`,
    );
  }
  return limitPermissionMessage(
    `Approved for this run only: ${summary}.${request?.jobId ? ' It will ask again next run.' : ''}`,
  );
}

function isMcpCapabilityProposal(
  request: PermissionApprovalRequest | undefined,
): boolean {
  const rule = request ? firstPersistentRule(request) : undefined;
  const capabilityId = rule ? parseSemanticCapabilityRule(rule) : undefined;
  return isMcpCapabilityProposalRequest({
    toolName: request?.toolName ?? '',
    toolInput: request?.toolInput,
    capabilityId,
    semanticCapabilityDefinitions: request?.semanticCapabilityDefinitions,
  });
}

export const PERMISSION_GLYPH = '🔐';

/** Provider-native prompt view; keep in sync with the plain-text formatter. */
export interface PermissionPromptParts {
  title: string;
  bodyLines: string[];
  contextLines: string[];
  replyInMinutes: number;
  waitsForDecision: boolean;
  fullView?: PermissionPromptFullView;
}

export function buildPermissionPromptParts(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): PermissionPromptParts {
  const batchParts = buildPermissionBatchPromptParts(request, timeoutMs);
  const waitsForDecision = Boolean(request.jobId);
  if (batchParts) return { ...batchParts, waitsForDecision };
  const replyInMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  const contextLines = formatPermissionContextLines(request);
  const fullView = buildPermissionPromptFullView(request);
  const amendmentParts = amendmentPromptParts(request, {
    contextLines,
    replyInMinutes,
    fullView,
    sanitize: sanitizePermissionText,
  });
  if (amendmentParts) {
    return {
      ...(amendmentParts as Omit<PermissionPromptParts, 'waitsForDecision'>),
      waitsForDecision,
    };
  }
  if (request.interaction) {
    const interaction = request.interaction;
    const rule = firstPersistentRule(request);
    const capabilityName = semanticCapabilityName(request, rule);
    const title = permissionPromptTitle(
      request.sourceAgentFolder,
      capabilityName ?? permissionAccessLabel(request),
    );
    const bodyLines = permissionRiskLines(request);
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
      waitsForDecision,
      fullView,
    };
  }
  const rule = firstPersistentRule(request);
  const capabilityName = semanticCapabilityName(request, rule);
  if (capabilityName) {
    const definition = semanticCapabilityDefinition(request, rule);
    const bodyLines = permissionRiskLines(request);
    const accountLabel =
      definition?.accountLabel ?? request.toolInput?.accountLabel;
    if (typeof accountLabel === 'string' && accountLabel.trim()) {
      bodyLines.push(
        `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
      );
    }
    if (!request.risk_category && definition?.risk) {
      if (request.risk_level)
        bodyLines[0] = `${bodyLines[0]} — ${humanizeIdentifier(definition.risk)}`;
      else bodyLines.push(`Risk: ${humanizeIdentifier(definition.risk)}`);
    }
    const networkLine = semanticCapabilityNetworkLine(definition);
    if (networkLine) bodyLines.push(networkLine);
    return {
      title: permissionPromptTitle(request.sourceAgentFolder, capabilityName),
      bodyLines,
      contextLines,
      replyInMinutes,
      waitsForDecision,
      fullView,
    };
  }
  const label = permissionAccessLabel(request);
  const bodyLines = [
    ...permissionRiskLines(request),
    ...formatPermissionToolInputLines(request, sanitizePermissionText, {
      sanitizeCommandText: sanitizePermissionCommandText,
    }),
  ];
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
    waitsForDecision,
    fullView,
  };
}

export function formatPermissionPromptPartsText(
  parts: PermissionPromptParts,
): string {
  const lines = [`${PERMISSION_GLYPH} ${parts.title}`];
  if (parts.bodyLines.length > 0) lines.push('', ...parts.bodyLines);
  if (parts.contextLines.length > 0) lines.push('', ...parts.contextLines);
  lines.push(
    permissionPromptWaitLine(parts.waitsForDecision, parts.replyInMinutes),
  );
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
  if (request.closestRule) {
    lines.push(
      `Approved pattern: ${sanitizePermissionText(request.closestRule.rule, 500, 160)}`,
    );
    const attemptedCommand = permissionAttemptedCommand(request);
    if (attemptedCommand) {
      lines.push(
        `Attempted command: ${sanitizePermissionCommandText(attemptedCommand, 500, 160)}`,
      );
    }
  }
  if (request.promotionHintCount && request.firstAskedAt) {
    const days = permissionAskSpanDays(request.firstAskedAt);
    lines.push(
      `Approved once ${request.promotionHintCount} times in ${days} ${days === 1 ? 'day' : 'days'} — and it is asking again now. Approve permanently?`,
    );
  }
  lines.push('The agent cannot approve this itself.');
  return lines;
}

function permissionAttemptedCommand(
  request: PermissionApprovalRequest,
): string | null {
  const command = request.toolInput?.command ?? request.toolInput?.cmd;
  if (typeof command !== 'string' || !command.trim()) return null;
  return runtimeDisplayCommand(command.trim()).command;
}

function permissionAskSpanDays(firstAskedAt: string): number {
  const firstAskedAtMs = Date.parse(firstAskedAt);
  if (!Number.isFinite(firstAskedAtMs)) return 1;
  return Math.max(1, Math.ceil((Date.now() - firstAskedAtMs) / 86_400_000));
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
  const lines = [title, ...permissionRiskLines(request)];
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
  const familyScopeLine = familyScopeCoverageLine(request);
  if (familyScopeLine) lines.push(familyScopeLine);
  lines.push('', ...formatPermissionContextLines(request));
  lines.push(permissionPromptWaitLine(Boolean(request.jobId), timeoutMinutes));
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
    ...permissionRiskLines(request),
  ];
  const accountLabel =
    definition?.accountLabel ?? request.toolInput?.accountLabel;
  if (typeof accountLabel === 'string' && accountLabel.trim()) {
    lines.push(
      `Account: ${sanitizePermissionText(accountLabel.trim(), 100, 40)}`,
    );
  }
  if (!request.risk_category && definition?.risk) {
    if (request.risk_level)
      lines[1] = `${lines[1]} — ${humanizeIdentifier(definition.risk)}`;
    else lines.push(`Risk: ${humanizeIdentifier(definition.risk)}`);
  }
  const networkLine = semanticCapabilityNetworkLine(definition);
  if (networkLine) lines.push(networkLine);
  const familyScopeLine = familyScopeCoverageLine(request);
  if (familyScopeLine) lines.push(familyScopeLine);
  lines.push('', ...formatPermissionContextLines(request));
  lines.push(permissionPromptWaitLine(Boolean(request.jobId), timeoutMinutes));
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

// The immediate action shows the exact command, but "Allow for future"
// persists the broader command-family rule - say so on the card instead of
// widening authority silently. Null for non-family rules, so non-command and
// semantic prompts are untouched.
function familyScopeCoverageLine(
  request: PermissionApprovalRequest,
): string | null {
  if (!permissionCommand(request)) return null;
  const rule = firstPersistentRule(request);
  if (!rule || !isFamilyRunCommandRule(rule)) return null;
  const scoped = parseReadableScopedToolRule(rule);
  if (!scoped) return null;
  return `Allow for future covers: ${sanitizePermissionText(scoped.scope, 120, 40)}`;
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
