import { evaluateAutonomousToolUse } from './tool-rule-matcher.js';
import {
  bashExecutableName,
  nonDurableBashLeafReason,
  normalizeBashLeafRuleContent,
  parseBashCommand,
} from './bash-command-parser.js';
import { isAdminMcpToolFullName } from './admin-mcp-tools.js';
import { isKnownProjectedBrowserMcpToolName } from './agent-tool-references.js';
import {
  commandText,
  hasBashMutationVerb,
  hasBashRedirect,
  hasProtectedPathInGhTextPayloadCommand,
  inferBashMutationTargets,
  inferBashTarget,
  isProviderMcpMutationCommand,
  isSafeProtectedPathTextPayloadCommand,
} from './tool-execution-bash-policy.js';
import {
  allProtectedPathMentions,
  firstProtectedPathMention,
  isMcpCapabilityPath,
  isProtectedCapabilityPathLike,
  isProviderSettingsPath,
  isRuntimeSettingsPath,
  isSkillCapabilityPath,
  protectedCapabilityPathMatch,
} from './tool-execution-protected-paths.js';

export type ToolExecutionOrigin =
  | 'sdk'
  | 'mcp'
  | 'browser'
  | 'scheduler_script'
  | 'host';

export type ToolExecutionKind =
  | 'bash'
  | 'file'
  | 'mcp'
  | 'browser'
  | 'config'
  | 'scheduler_script'
  | 'sdk'
  | 'unknown';

export type ToolExecutionMode = 'interactive' | 'autonomous' | 'host_direct';
export type ToolMutationIntent =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'configure'
  | 'unknown';
export type ToolPolicyDecisionStatus =
  | 'allow'
  | 'deny'
  | 'needs_approval'
  | 'not_applicable';

export interface ToolExecutionRequest {
  origin: ToolExecutionOrigin;
  toolKind: ToolExecutionKind;
  toolName: string;
  input: unknown;
  runContext: {
    appId?: string;
    runId?: string;
    agentId?: string;
    conversationId?: string;
    jobId?: string;
    threadId?: string;
  };
  executionMode: ToolExecutionMode;
  targetResource?: string;
  mutationIntent: ToolMutationIntent;
  actionPreview?: string;
}

export interface ToolPolicyDecision {
  status: ToolPolicyDecisionStatus;
  reason: string;
  audit: {
    category: 'tool_execution';
    origin: ToolExecutionOrigin;
    toolKind: ToolExecutionKind;
    toolName: string;
    mutationIntent: ToolMutationIntent;
    targetResource?: string;
    runId?: string;
    jobId?: string;
  };
  recoveryAction?: string;
  matchedRule?: string;
  closestRule?: {
    rule: string;
    reason: string;
  };
}

const CAPABILITY_REQUEST_TOOLS = new Set([
  'mcp__myclaw__request_mcp_server',
  'mcp__myclaw__request_skill_install',
  'mcp__myclaw__request_skill_proposal',
  'mcp__myclaw__request_skill_dependency_install',
  'mcp__myclaw__request_permission',
]);

const FILE_MUTATION_TOOLS = new Set(
  'Write Edit MultiEdit NotebookEdit'.split(' '),
);
const READ_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep']);

export class ToolExecutionClassifier {
  classify(input: {
    origin: ToolExecutionOrigin;
    toolName: string;
    toolInput: unknown;
    executionMode?: ToolExecutionMode;
    runContext?: ToolExecutionRequest['runContext'];
  }): ToolExecutionRequest {
    const toolName = input.toolName.trim();
    const toolKind = classifyToolKind(toolName);
    const targetResource = inferTargetResource(toolName, input.toolInput);
    return {
      origin: input.origin,
      toolKind,
      toolName,
      input: input.toolInput,
      runContext: input.runContext ?? {},
      executionMode: input.executionMode ?? 'interactive',
      targetResource,
      mutationIntent: inferMutationIntent(toolName, input.toolInput),
      actionPreview: inferActionPreview(toolName, input.toolInput),
    };
  }
}

export class ToolExecutionPolicyService {
  evaluate(input: {
    request: ToolExecutionRequest;
    allowedToolRules?: readonly string[];
    autonomousAllowedToolRules?: readonly string[];
  }): ToolPolicyDecision {
    const protectedDecision = evaluateProtectedCapabilityRequest(input.request);
    if (protectedDecision) return protectedDecision;

    if (input.request.executionMode === 'autonomous') {
      const rules =
        input.autonomousAllowedToolRules ?? input.allowedToolRules ?? [];
      const toolPolicy = evaluateAutonomousToolUse({
        rules,
        toolName: input.request.toolName,
        toolInput: input.request.input,
      });
      if (toolPolicy.allowed) {
        return decision(input.request, 'allow', {
          reason: `Allowed by autonomous tool rule ${toolPolicy.matchedRule}.`,
          matchedRule: toolPolicy.matchedRule,
        });
      }
      return decision(input.request, 'deny', {
        reason: autonomousDenyReason(input.request.toolName, toolPolicy.reason),
        recoveryAction: autonomousGrantRecovery(input.request),
        closestRule: toolPolicy.closestRule,
      });
    }

    if (input.allowedToolRules?.length) {
      const toolPolicy = evaluateAutonomousToolUse({
        rules: input.allowedToolRules,
        toolName: input.request.toolName,
        toolInput: input.request.input,
      });
      if (toolPolicy.allowed) {
        return decision(input.request, 'allow', {
          reason: `Allowed by selected capability rule ${toolPolicy.matchedRule}.`,
          matchedRule: toolPolicy.matchedRule,
        });
      }
      return decision(input.request, 'not_applicable', {
        reason: selectedCapabilityMissReason(toolPolicy.reason),
        closestRule: toolPolicy.closestRule,
      });
    }

    return decision(input.request, 'not_applicable', {
      reason: 'No canonical tool execution policy matched.',
    });
  }
}

export function evaluateProtectedCapabilityToolUse(
  toolName: string,
  input: unknown,
): { reason: string; recoveryAction: string } | null {
  const request = new ToolExecutionClassifier().classify({
    origin: 'sdk',
    toolName,
    toolInput: input,
  });
  const decision = evaluateProtectedCapabilityRequest(request);
  if (!decision || decision.status !== 'deny') return null;
  return {
    reason: decision.reason,
    recoveryAction: decision.recoveryAction ?? protectedCapabilityRecovery(),
  };
}

function evaluateProtectedCapabilityRequest(
  request: ToolExecutionRequest,
): ToolPolicyDecision | null {
  if (CAPABILITY_REQUEST_TOOLS.has(request.toolName)) return null;

  if (request.toolName === 'Config') {
    const setting = stringField(request.input, 'setting');
    if (
      setting &&
      /(^|\.)mcpServers($|\.)|(^|\.)permissions($|\.)|permissionMode/i.test(
        setting,
      )
    ) {
      return decision(request, 'deny', {
        reason: `Config setting "${setting}" changes capability or permission policy.`,
        recoveryAction: protectedCapabilityRecovery(),
      });
    }
    return null;
  }

  if (request.toolName === 'Bash') {
    const command = commandText(request.input);
    if (!command) return null;
    if (isProviderMcpMutationCommand(command)) {
      return decision(request, 'deny', {
        reason:
          'Shell command attempts to change MCP capability configuration.',
        recoveryAction: protectedCapabilityRecovery(),
      });
    }
    if (hasProtectedPathInGhTextPayloadCommand(command)) {
      const mentionedPath = firstProtectedPathMention(command);
      return decision(request, 'deny', {
        reason: mentionedPath
          ? `Shell command references protected capability target "${mentionedPath}".`
          : 'Shell command references protected capability target through GitHub payload arguments.',
        recoveryAction: protectedCapabilityRecovery(),
      });
    }
    const safeTextPayloadCommand =
      isSafeProtectedPathTextPayloadCommand(command);
    const protectedPathMention = allProtectedPathMentions(command)[0];
    if (!safeTextPayloadCommand && protectedPathMention) {
      return decision(request, 'deny', {
        reason: `Shell command references protected capability target "${protectedPathMention}".`,
        recoveryAction: protectedCapabilityRecovery(),
      });
    }
    const mutatesTarget =
      hasBashMutationVerb(command) || hasBashRedirect(command);
    if (!mutatesTarget) {
      return null;
    }
    const mutationTarget =
      inferBashMutationTargets(command).find(isProtectedCapabilityPathLike) ??
      (request.targetResource &&
      isProtectedCapabilityPathLike(request.targetResource)
        ? request.targetResource
        : undefined);
    if (mutationTarget) {
      return decision(request, 'deny', {
        reason: `Shell command mutates protected capability target "${mutationTarget}".`,
        recoveryAction: protectedCapabilityRecovery(),
      });
    }
    return null;
  }

  if (!FILE_MUTATION_TOOLS.has(request.toolName)) return null;
  if (!request.targetResource) return null;
  const protectedPath = protectedCapabilityPathMatch(request.targetResource);
  const protectedKind = protectedPath && protectedFilePathKind(protectedPath);
  if (protectedKind) {
    return decision(request, 'deny', {
      reason: `File path "${request.targetResource}" is ${protectedKind}.`,
      recoveryAction: protectedCapabilityRecovery(),
    });
  }
  return null;
}

function protectedFilePathKind(protectedPath: string): string | undefined {
  if (isSkillCapabilityPath(protectedPath)) return 'a skill capability path';
  if (isMcpCapabilityPath(protectedPath))
    return 'an MCP capability configuration path';
  if (isProviderSettingsPath(protectedPath))
    return 'a provider settings capability path';
  if (isRuntimeSettingsPath(protectedPath))
    return 'a runtime settings capability path';
  return undefined;
}

function decision(
  request: ToolExecutionRequest,
  status: ToolPolicyDecisionStatus,
  options: {
    reason: string;
    recoveryAction?: string;
    matchedRule?: string;
    closestRule?: ToolPolicyDecision['closestRule'];
  },
): ToolPolicyDecision {
  return {
    status,
    reason: options.reason,
    audit: {
      category: 'tool_execution',
      origin: request.origin,
      toolKind: request.toolKind,
      toolName: request.toolName,
      mutationIntent: request.mutationIntent,
      ...(request.targetResource
        ? { targetResource: request.targetResource }
        : {}),
      ...(request.runContext.runId ? { runId: request.runContext.runId } : {}),
      ...(request.runContext.jobId ? { jobId: request.runContext.jobId } : {}),
    },
    ...(options.recoveryAction
      ? { recoveryAction: options.recoveryAction }
      : {}),
    ...(options.matchedRule ? { matchedRule: options.matchedRule } : {}),
    ...(options.closestRule ? { closestRule: options.closestRule } : {}),
  };
}

function autonomousDenyReason(
  toolName: string,
  mismatchReason: string | undefined,
): string {
  const prefix = `Tool not on autonomous run allowlist: ${toolName}.`;
  return mismatchReason ? `${prefix} ${mismatchReason}` : prefix;
}

function selectedCapabilityMissReason(
  mismatchReason: string | undefined,
): string {
  return mismatchReason
    ? `No canonical tool execution policy matched. ${mismatchReason}`
    : 'No canonical tool execution policy matched.';
}

function classifyToolKind(toolName: string): ToolExecutionKind {
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'Config') return 'config';
  if (FILE_MUTATION_TOOLS.has(toolName) || READ_TOOLS.has(toolName))
    return 'file';
  if (toolName.startsWith('mcp__myclaw__browser_')) {
    return 'browser';
  }
  if (toolName.startsWith('mcp__')) return 'mcp';
  return toolName ? 'sdk' : 'unknown';
}

function inferMutationIntent(
  toolName: string,
  input: unknown,
): ToolMutationIntent {
  if (toolName === 'Config') return 'configure';
  if (toolName === 'Bash') {
    const command = commandText(input);
    if (!command) return 'execute';
    if (/\brm\s+/.test(command)) return 'delete';
    if (isProviderMcpMutationCommand(command)) return 'configure';
    if (hasBashMutationVerb(command) || hasBashRedirect(command))
      return 'write';
    return 'execute';
  }
  if (READ_TOOLS.has(toolName)) return 'read';
  if (FILE_MUTATION_TOOLS.has(toolName)) return 'write';
  return 'unknown';
}

function inferTargetResource(
  toolName: string,
  input: unknown,
): string | undefined {
  if (toolName === 'Bash') {
    const command = commandText(input);
    return command ? inferBashTarget(command) : undefined;
  }
  return (
    stringField(input, 'file_path') ??
    stringField(input, 'filePath') ??
    stringField(input, 'path') ??
    stringField(input, 'notebook_path') ??
    stringField(input, 'notebookPath') ??
    stringField(input, 'url')
  );
}

function inferActionPreview(
  toolName: string,
  input: unknown,
): string | undefined {
  if (toolName === 'Bash') return commandText(input);
  return undefined;
}

function stringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function protectedCapabilityRecovery(): string {
  return 'Use request_skill_install, request_skill_proposal, request_skill_dependency_install, request_mcp_server, or request_permission so the change is reviewed, stored durably, and activated through MyClaw capability flows.';
}

function autonomousGrantRecovery(request: ToolExecutionRequest): string {
  if (isKnownProjectedBrowserMcpToolName(request.toolName)) {
    return 'request_permission { "permissionKind": "tool", "toolName": "Browser", "toolCategory": "browser", "temporaryOnly": false, "reason": "This autonomous run needs browser access." }';
  }
  if (request.toolName === 'Bash') {
    const command = commandText(request.input);
    const rule = command ? persistentBashRecoveryRule(command) : undefined;
    if (!rule) {
      return 'Update the autonomous run to use a reviewed semantic capability or invoke a scoped Bash(...) command directly. This Bash command cannot be durably approved for autonomous runs.';
    }
    return `request_permission { "permissionKind": "tool", "toolName": "Bash"${rule ? `, "rule": "${escapeJson(rule)}"` : ''}, "temporaryOnly": false, "reason": "This autonomous run needs scoped Bash access." }`;
  }
  if (isAdminMcpToolFullName(request.toolName)) {
    return `request_permission { "permissionKind": "tool", "toolName": "${request.toolName}", "temporaryOnly": false, "reason": "This autonomous run needs ${request.toolName} access." }`;
  }
  const thirdPartyMcp = thirdPartyMcpToolServerName(request.toolName);
  if (thirdPartyMcp) {
    return `request_mcp_server { "name": "${escapeJson(thirdPartyMcp)}", "transport": "http", "reason": "This autonomous run needs the ${escapeJson(thirdPartyMcp)} MCP server capability." }`;
  }
  const toolName = isKnownProjectedBrowserMcpToolName(request.toolName)
    ? 'Browser'
    : request.toolName;
  return `request_permission { "permissionKind": "tool", "toolName": "${escapeJson(toolName)}", "temporaryOnly": false, "reason": "This autonomous run needs ${escapeJson(toolName)} access." }`;
}

function thirdPartyMcpToolServerName(toolName: string): string | undefined {
  const match = /^mcp__([^_][A-Za-z0-9_.-]*)__/.exec(toolName);
  const serverName = match?.[1];
  if (!serverName || serverName === 'myclaw') return undefined;
  return serverName;
}

function escapeJson(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function persistentBashRecoveryRule(command: string): string | undefined {
  const parsed = parseBashCommand(command);
  if (!parsed.ok || parsed.leaves.length !== 1) return undefined;
  const [leaf] = parsed.leaves;
  if (!leaf || nonDurableBashLeafReason(leaf)) return undefined;
  if (inlineInterpreterLeaf(leaf.argv)) return undefined;
  if (leaf.redirects.some((redirect) => redirect.destructive)) return undefined;
  return normalizeBashLeafRuleContent(leaf);
}

function inlineInterpreterLeaf(argv: readonly string[]): boolean {
  const executable = bashExecutableName(argv[0] ?? '');
  if (
    !['node', 'python', 'python3', 'ruby', 'perl', 'php'].includes(executable)
  )
    return false;
  return ['-c', '-e'].includes(argv[1] ?? '');
}
