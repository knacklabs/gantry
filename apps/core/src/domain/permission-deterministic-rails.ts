import permissionCredentialPathPattern from './permission-credential-path-pattern.json' with { type: 'json' };
import { decisionForMode } from './permission-decision.js';
import {
  RailSignal,
  type RailSignal as RailSignalValue,
} from './permission-lane.js';
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
  parseBashCommandForHardBoundaryAnalysis,
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
      railSignal: RailSignalValue;
      hardFloor?: true;
    }
  | (PermissionApprovalDecision & {
      railOutcome: 'allow' | 'deny';
    });

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
  'scheduler_get_dead_letter',
  'scheduler_list_notification_targets',
  'scheduler_wait_for_events',
  'memory_search',
  'memory_review_pending',
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
  // Human-gated recovery proposals (0052 as amended by 0123, Ravi 2026-08-12:
  // system tools never need approval). These tools only create review
  // metadata — every effect requires an authenticated human decision — so
  // gating them deadlocks recovery: the CAPFIX-1 amendment card could never
  // be raised by the autonomous runs that need it. Input-gated: complete,
  // inspectable inputs pass; redacted/truncated inputs still fail closed.
  // They remain EXCLUDED from durable exact-tool grants (admin-mcp-tools).
  'request_access',
  'request_skill_install',
  'request_skill_proposal',
  'request_skill_dependency_install',
  'request_mcp_server',
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
    return hardFloorAsk(
      'Exact tool input is missing, redacted, or truncated.',
      RailSignal.Privileged,
    );
  }
  const isInputGatedBirthrightTool =
    gantryTool !== null &&
    GANTRY_INPUT_GATED_BIRTHRIGHT_TOOLS.has(gantryTool[1]!);
  if (isInputGatedBirthrightTool && !hasRiskRelevantSanitization(request)) {
    return allow(request, 'Agent self-surface birthright.', 'birthright');
  }
  if (isInputGatedBirthrightTool) {
    return hardFloorAsk(
      'Displayed tool input is sanitized or redacted.',
      RailSignal.SecretPath,
    );
  }
  // Evaluate the 16K classifier view, not the 500-char display copy, so the
  // command we inspect matches the truncation signal inputIsIncomplete guards.
  const toolInput = request.classifierToolInput ?? request.toolInput;
  if (!toolInput)
    return ask('Exact tool input is missing.', RailSignal.Privileged);

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
    return ask('Exact shell command input is missing.', RailSignal.Privileged);
  const parsed = parseBashCommand(command);
  if (!parsed.ok) {
    // If the deterministic parser cannot model the command, no downstream
    // layer can grant it directly. Interactive auto may separately prove the
    // one read-only find shape before honoring the classifier.
    return hardFloorAsk(
      `Shell input is unsupported: ${parsed.reason}`,
      parseBashCommandForHardBoundaryAnalysis(command).ok
        ? RailSignal.UnsupportedMetaExecutor
        : RailSignal.Privileged,
    );
  }
  // GOVERNING PRINCIPLE: A rail ASK is a HARD FLOOR whenever the command's
  // effect cannot be DETERMINISTICALLY BOUNDED. Only bounded, inspectable
  // effects may remain classifier-eligible.
  if (parsed.leaves.some(isInterpreterString)) {
    return hardFloorAsk(
      'An interpreter string requires approval.',
      RailSignal.Privileged,
    );
  }
  const protectedPath = containsProtectedPath(
    toolInput,
    command,
    parsed.leaves,
  );
  const destructiveHint = destructiveBashCommandHint(command);
  if (destructiveHint || parsed.leaves.some(isDestructiveLeaf)) {
    const hardFloor =
      Boolean(destructiveHint) ||
      parsed.leaves.some(isHardFloorDestructiveLeaf) ||
      protectedPath;
    return hardFloor
      ? hardFloorAsk(
          'Destructive command requires approval.',
          protectedPath ? RailSignal.SecretPath : RailSignal.Destructive,
        )
      : ask('Destructive command requires approval.', RailSignal.Destructive);
  }
  if (protectedPath) {
    return hardFloorAsk(
      'Command references a credential, secret, or protected path.',
      RailSignal.SecretPath,
    );
  }
  if (parsed.leaves.some(isPrivilegedLeaf)) {
    return hardFloorAsk(
      'Privileged command requires approval.',
      RailSignal.Privileged,
    );
  }
  if (uploadsLocalFile(command)) {
    return hardFloorAsk(
      'Network command uploads local file content.',
      RailSignal.Egress,
    );
  }
  if (!readOnly.allowed) {
    const outside = outOfTrustedRootReason(
      parsed.leaves,
      input.workspaceRoot,
      input.trustedRoots ?? [],
    );
    if (outside) {
      return (input.trustedRoots?.length ?? 0) > 0
        ? hardFloorAsk(outside, RailSignal.OutOfTrustedRoot)
        : ask(outside, RailSignal.OutOfTrustedRoot);
    }
  }
  return readOnly.allowed ? allow(request, readOnly.reason) : undefined;
}

export function permissionRiskForDeterministicRailDecision(
  decision: PermissionDeterministicRailDecision | undefined,
): PermissionDeterministicRailRisk | undefined {
  if (decision?.railOutcome !== 'ask') return undefined;
  switch (decision.railSignal) {
    case RailSignal.Destructive:
      return decision.hardFloor
        ? { level: 'high', category: 'destructive' }
        : { level: 'medium', category: 'destructive' };
    case RailSignal.Egress:
      return { level: 'medium', category: 'network' };
    case RailSignal.Privileged:
    case RailSignal.UnsupportedMetaExecutor:
      return { level: 'high', category: 'privileged' };
    case RailSignal.SecretPath:
      return { level: 'high', category: 'secret' };
    case RailSignal.OutOfTrustedRoot:
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

function isHardFloorDestructiveLeaf(leaf: BashCommandLeaf): boolean {
  return (
    bashExecutableName(leaf.argv[0] ?? '') !== 'rm' && isDestructiveLeaf(leaf)
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
  railSignal: RailSignalValue,
): PermissionDeterministicRailDecision {
  return { railOutcome: 'ask', reason, railSignal };
}

function hardFloorAsk(
  reason: string,
  railSignal: RailSignalValue,
): PermissionDeterministicRailDecision {
  return { railOutcome: 'ask', reason, railSignal, hardFloor: true };
}

function allow(
  request: PermissionApprovalRequest,
  reason: string,
  decidedBy = 'deterministic_read_only',
): PermissionDeterministicRailDecision {
  return {
    ...decisionForMode(request, 'allow_once', decidedBy, 'machine'),
    railOutcome: 'allow',
    reason,
  };
}
