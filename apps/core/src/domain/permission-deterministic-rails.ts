import permissionCredentialPathPattern from './permission-credential-path-pattern.json' with { type: 'json' };
import { decisionForMode } from './permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
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
    }
  | (PermissionApprovalDecision & {
      railOutcome: 'allow' | 'deny';
    });

const SHELL_TOOLS = new Set(['Bash', 'RunCommand']);
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
  if (inputIsIncomplete(request)) {
    return ask('Exact tool input is missing or the command was truncated.');
  }
  // Evaluate the 16K classifier view, not the 500-char display copy, so the
  // command we inspect matches the truncation signal inputIsIncomplete guards.
  const toolInput = request.classifierToolInput ?? request.toolInput;
  if (!toolInput) return ask('Exact tool input is missing.');

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
  if (!command) return ask('Exact shell command input is missing.');
  const parsed = parseBashCommand(command);
  if (!parsed.ok) return ask(`Shell input is unsupported: ${parsed.reason}`);
  if (parsed.leaves.some(isInterpreterString)) {
    return ask('An interpreter string requires approval.');
  }
  if (
    destructiveBashCommandHint(command) ||
    parsed.leaves.some(isDestructiveLeaf)
  ) {
    return ask('Destructive command requires approval.');
  }
  if (uploadsLocalFile(command)) {
    return ask('Network command uploads local file content.');
  }
  if (containsProtectedPath(toolInput, command, parsed.leaves)) {
    return ask('Command references a credential, secret, or protected path.');
  }
  if (!readOnly.allowed) {
    const outside = outOfTrustedRootReason(
      parsed.leaves,
      input.workspaceRoot,
      input.trustedRoots ?? [],
    );
    if (outside) return ask(outside);
  }
  if (parsed.leaves.some(isPrivilegedLeaf)) {
    return ask('Privileged command requires approval.');
  }
  return readOnly.allowed ? allow(request, readOnly.reason) : undefined;
}

/**
 * Incomplete ⇒ the risk-relevant input is genuinely unavailable, so we must
 * ask. That is ONLY when the toolInput is missing, or a shell command field was
 * actually TRUNCATED (`toolInputTruncatedPaths` contains `command`/`cmd`).
 * Sensitive-key redaction replaces secret VALUES — not the risk-relevant
 * verbs/paths — and 500-char display alteration is not a risk gap now that the
 * host env-prefix is stripped, so neither alone marks the input incomplete.
 */
function inputIsIncomplete(request: PermissionApprovalRequest): boolean {
  const ipc = request as PermissionApprovalRequest & {
    toolInputTruncatedPaths?: string[];
  };
  if (!request.toolInput) return true;
  const truncated = ipc.toolInputTruncatedPaths ?? [];
  return truncated.includes('command') || truncated.includes('cmd');
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

function ask(reason: string): PermissionDeterministicRailDecision {
  return { railOutcome: 'ask', reason };
}

function allow(
  request: PermissionApprovalRequest,
  reason: string,
): PermissionDeterministicRailDecision {
  return {
    ...decisionForMode(request, 'allow_once', 'deterministic_read_only'),
    railOutcome: 'allow',
    reason,
  };
}
