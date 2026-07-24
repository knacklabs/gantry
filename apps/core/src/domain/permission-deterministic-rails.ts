import permissionCredentialPathPattern from './permission-credential-path-pattern.json' with { type: 'json' };
import { decisionForMode } from './permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionRiskCategory,
  PermissionRiskLevel,
} from './types.js';
import {
  evaluateAutoPermissionReadOnlyGate,
  type McpReadBinding,
} from '../shared/auto-permission-read-only-gate.js';
import {
  bashExecutableName,
  destructiveBashCommandHint,
  parseBashCommand,
  type BashCommandLeaf,
} from '../shared/bash-command-parser.js';
import { outOfTrustedRootReason } from '../shared/permission-trusted-paths.js';
import { allProtectedPathMentions } from '../shared/tool-execution-protected-paths.js';

export interface PermissionDeterministicRailsInput {
  request: PermissionApprovalRequest;
  approvedCapabilityIds?: readonly string[];
  workspaceRoot?: string;
  trustedRoots?: readonly string[];
  reviewedMcpReadBindings?: readonly McpReadBinding[];
}

export type PermissionDeterministicRailDecision =
  | {
      railOutcome: 'ask';
      reason: string;
      railSignal: PermissionDeterministicRailSignal;
    }
  | (PermissionApprovalDecision & {
      railOutcome: 'allow' | 'deny';
    });

export type PermissionDeterministicRailSignal =
  | 'destructive'
  | 'egress'
  | 'privileged'
  | 'secret_path'
  | 'out_of_trusted_root';

export interface PermissionDeterministicRailRisk {
  level: PermissionRiskLevel;
  category: PermissionRiskCategory;
}

const SHELL_TOOLS = new Set(['Bash', 'RunCommand']);
const GANTRY_INPUT_INDEPENDENT_BIRTHRIGHT_TOOLS = new Set([
  'ask_user_question',
  'render_status',
  'render_facts',
  'render_list',
  'render_table',
  'render_form',
  'render_media',
  'render_progress',
  'task_get',
  'task_list',
  'scheduler_list_jobs',
  'scheduler_list_runs',
  'scheduler_list_events',
  'scheduler_list_models',
  'scheduler_get_job',
  'memory_search',
  'brain_search',
  'brain_query',
  'continuity_summary',
  'mcp_list_tools',
  'mcp_search_tools',
  'mcp_describe_tool',
  'agent_profile_read',
]);
const GANTRY_INPUT_GATED_BIRTHRIGHT_TOOLS = new Set([
  'send_message',
  'todo_update',
  'memory_save',
  'brain_write',
  'procedure_save',
  'task_cancel',
  'task_message',
]);
const DESTRUCTIVE_EXECUTABLE =
  /^(?:dd|mkfs(?:\..+)?|rm|rmdir|shred|truncate|unlink)$/;
const PRIVILEGED_EXECUTABLE = /^(?:doas|launchctl|pkexec|su|sudo|systemctl)$/;
const CREDENTIAL_PATH = new RegExp(
  permissionCredentialPathPattern.pattern,
  'i',
);

export function evaluatePermissionDeterministicRails(
  input: PermissionDeterministicRailsInput,
): PermissionDeterministicRailDecision | undefined {
  const { request } = input;
  const gantryTool = /^mcp__gantry__(.+)$/.exec(request.toolName);
  // INVARIANT (decision 0045): A/B tools are intentionally payload-independent.
  // They only display to, or read state for, the trusted user, who sees the real
  // execution input; engine redaction/truncation conceals nothing from that
  // audience. Gating them would reintroduce the ask_user_question deadlock.
  if (
    gantryTool !== null &&
    GANTRY_INPUT_INDEPENDENT_BIRTHRIGHT_TOOLS.has(gantryTool[1]!)
  ) {
    return allow(request, 'Agent self-surface birthright.', 'birthright');
  }
  if (inputIsIncomplete(request)) {
    return ask(
      'Exact tool input is missing, redacted, or truncated.',
      'privileged',
    );
  }
  const isInputGatedBirthrightTool =
    gantryTool !== null &&
    GANTRY_INPUT_GATED_BIRTHRIGHT_TOOLS.has(gantryTool[1]!);
  if (isInputGatedBirthrightTool && !hasRiskRelevantSanitization(request)) {
    return allow(request, 'Agent self-surface birthright.', 'birthright');
  }
  if (isInputGatedBirthrightTool) {
    return ask('Displayed tool input is sanitized or redacted.', 'secret_path');
  }
  // Evaluate the 16K classifier view, not the 500-char display copy, so the
  // command we inspect matches the truncation signal inputIsIncomplete guards.
  const toolInput = request.classifierToolInput ?? request.toolInput;
  if (!toolInput) return ask('Exact tool input is missing.', 'privileged');

  const readOnly = evaluateAutoPermissionReadOnlyGate({
    canonicalToolName: request.toolName,
    toolInput,
    approvedCapabilityIds: [...(input.approvedCapabilityIds ?? [])],
    workspaceRoot: input.workspaceRoot,
    reviewedMcpReadBindings: input.reviewedMcpReadBindings,
  });
  if (!SHELL_TOOLS.has(request.toolName)) {
    return readOnly.allowed ? allow(request, readOnly.reason) : undefined;
  }

  const command = commandText(toolInput);
  if (!command)
    return ask('Exact shell command input is missing.', 'privileged');
  const parsed = parseBashCommand(command);
  if (!parsed.ok)
    return ask(`Shell input is unsupported: ${parsed.reason}`, 'privileged');
  if (parsed.leaves.some(isInterpreterString)) {
    return ask('An interpreter string requires approval.', 'privileged');
  }
  if (
    destructiveBashCommandHint(command) ||
    parsed.leaves.some(isDestructiveLeaf)
  ) {
    return ask('Destructive command requires approval.', 'destructive');
  }
  if (uploadsLocalFile(command)) {
    return ask('Network command uploads local file content.', 'egress');
  }
  if (containsProtectedPath(toolInput, command, parsed.leaves)) {
    return ask(
      'Command references a credential, secret, or protected path.',
      'secret_path',
    );
  }
  if (!readOnly.allowed) {
    const outside = outOfTrustedRootReason(
      parsed.leaves,
      input.workspaceRoot,
      input.trustedRoots ?? [],
    );
    if (outside) return ask(outside, 'out_of_trusted_root');
  }
  if (parsed.leaves.some(isPrivilegedLeaf)) {
    return ask('Privileged command requires approval.', 'privileged');
  }
  return readOnly.allowed ? allow(request, readOnly.reason) : undefined;
}

export function permissionRiskForDeterministicRailDecision(
  decision: PermissionDeterministicRailDecision | undefined,
): PermissionDeterministicRailRisk | undefined {
  if (decision?.railOutcome !== 'ask') return undefined;
  switch (decision.railSignal) {
    case 'destructive':
      return { level: 'high', category: 'destructive' };
    case 'egress':
      return { level: 'medium', category: 'network' };
    case 'privileged':
      return { level: 'high', category: 'privileged' };
    case 'secret_path':
      return { level: 'high', category: 'secret' };
    case 'out_of_trusted_root':
      return { level: 'medium', category: 'filesystem' };
  }
}

/**
 * Incomplete ⇒ the risk-relevant input is genuinely unavailable, so we must
 * ask. Without a classifier view, display sanitization is relevant only when
 * its altered paths implicate the effect-bearing input: command/cmd for shell
 * tools, or any field for non-shell tools. With a classifier view, its existing
 * redaction/truncation metadata remains authoritative.
 *
 */
function inputIsIncomplete(request: PermissionApprovalRequest): boolean {
  const ipc = request as PermissionApprovalRequest & {
    toolInputRedactedPaths?: string[];
    toolInputTruncatedPaths?: string[];
  };
  if (!request.toolInput) return true;
  if (!request.classifierToolInput) {
    return SHELL_TOOLS.has(request.toolName)
      ? hasCommandPath(request.toolInputSanitizedPaths)
      : (request.toolInputSanitizedPaths?.length ?? 0) > 0;
  }
  if ((ipc.toolInputTruncatedPaths?.length ?? 0) > 0) return true;
  if (!SHELL_TOOLS.has(request.toolName)) {
    // Mirror the effect-key no-cache invariant: any hidden non-shell field may
    // be effect-bearing, so it must not reach a deterministic auto-allow.
    return (ipc.toolInputRedactedPaths?.length ?? 0) > 0;
  }
  return hasCommandPath(ipc.toolInputRedactedPaths);
}

function hasCommandPath(paths: readonly string[] | undefined): boolean {
  return paths?.some((path) => path === 'command' || path === 'cmd') ?? false;
}

function hasRiskRelevantSanitization(
  request: PermissionApprovalRequest,
): boolean {
  const ipc = request as PermissionApprovalRequest & {
    toolInputRedactedPaths?: string[];
  };
  return (
    request.toolInputSanitized === true ||
    (request.toolInputSanitizedPaths?.length ?? 0) > 0 ||
    (ipc.toolInputRedactedPaths?.length ?? 0) > 0
  );
}

function isInterpreterString(leaf: BashCommandLeaf): boolean {
  const executable = bashExecutableName(leaf.argv[0] ?? '');
  const args = leaf.argv.slice(1);
  return (
    (executable === 'node' &&
      args.some((arg) => arg === '-e' || arg === '--eval')) ||
    ((executable === 'python' || executable === 'python3') &&
      args.includes('-c')) ||
    ((executable === 'perl' || executable === 'ruby') && args.includes('-e'))
  );
}

function isDestructiveLeaf(leaf: BashCommandLeaf): boolean {
  const executable = bashExecutableName(leaf.argv[0] ?? '');
  if (
    DESTRUCTIVE_EXECUTABLE.test(executable) ||
    leaf.redirects.some(({ destructive }) => destructive)
  ) {
    return true;
  }
  if (executable !== 'git') return false;
  const args = leaf.argv.slice(1);
  return (
    /\b(?:clean|reset|restore)\b/.test(args.join(' ')) ||
    args.includes('-D') ||
    (args.includes('checkout') && args.includes('--')) ||
    args.some((arg) => /^(?:-f|--force(?:-with-lease)?)$/.test(arg))
  );
}

function uploadsLocalFile(command: string): boolean {
  return (
    /\bcurl\b[\s\S]*(?:(?:-d|--data(?:-binary|-urlencode)?|--form)(?:=|\s)+@|(?:-F)[^\s]*=@|(?:-T|--upload-file)(?:=|\s)+\S+)/i.test(
      command,
    ) || /\bwget\b[\s\S]*--(?:post|body)-file(?:=|\s)+\S+/i.test(command)
  );
}

function containsProtectedPath(
  toolInput: Record<string, unknown>,
  command: string,
  leaves: readonly BashCommandLeaf[],
): boolean {
  if (allProtectedPathMentions(command).length > 0) return true;
  return [
    ...stringValues(toolInput),
    ...leaves.flatMap((leaf) => [
      ...leaf.argv,
      ...leaf.redirects.map(({ target }) => target),
    ]),
  ].some((value) => CREDENTIAL_PATH.test(value.replaceAll('\\', '/')));
}

function isPrivilegedLeaf(leaf: BashCommandLeaf): boolean {
  return PRIVILEGED_EXECUTABLE.test(bashExecutableName(leaf.argv[0] ?? ''));
}

function commandText(input: Record<string, unknown>): string | undefined {
  const value = input.command ?? input.cmd;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringValues);
}

function ask(
  reason: string,
  railSignal: PermissionDeterministicRailSignal,
): PermissionDeterministicRailDecision {
  return { railOutcome: 'ask', reason, railSignal };
}

function allow(
  request: PermissionApprovalRequest,
  reason: string,
  decidedBy = 'deterministic_read_only',
): PermissionDeterministicRailDecision {
  return {
    ...decisionForMode(request, 'allow_once', decidedBy),
    railOutcome: 'allow',
    reason,
  };
}
