import fs from 'fs';
import path from 'path';

import { bashExecutableName, parseBashCommand } from './bash-command-parser.js';
import { mcpToolPatternCovers } from './mcp-tool-scope.js';
import { allProtectedPathMentions } from './tool-execution-protected-paths.js';

export interface McpReadBinding {
  capabilityId: string;
  toolPattern: string;
}

export interface AutoPermissionReadOnlyGateInput {
  canonicalToolName: string;
  toolInput: unknown;
  approvedCapabilityIds: readonly string[];
  workspaceRoot?: string;
  reviewedMcpReadBindings?: readonly McpReadBinding[];
}

export interface AutoPermissionReadOnlyGateResult {
  allowed: boolean;
  reason: string;
}

const FILE_CAPABILITY_DOMAINS = new Set([
  'file',
  'files',
  'filesystem',
  'repo',
  'workspace',
]);
const CAT_OPTIONS = new Set([
  '-A',
  '-E',
  '-T',
  '-b',
  '-n',
  '-s',
  '-v',
  '--number',
  '--number-nonblank',
  '--show-all',
  '--show-ends',
  '--show-nonprinting',
  '--show-tabs',
  '--squeeze-blank',
]);
// No -a/-A (hidden entries), -H/-L (symlink following), or -f (BSD ls -f
// implies -a): those bypass the hidden/symlink target checks below.
const LS_OPTIONS = /^-(?:[1CFRSTUbcdghiklmnopqrstux@])+$/;
const SHELL_CONTROL_OR_EXPANSION = /[\r\n#;&|<>`$(){}*?\[\]]/;
const SECRET_KEY =
  /(?:^|[_-])(?:apikey|authorization|credential|key|password|private[_-]?key|secret|token)(?:$|[_-])/i;
const SECRET_PATH =
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|environ(?:ment)?|id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?|[^/\\]*(?:api[_-]?key|credential|private[_-]?key|secret|token)[^/\\]*|(?:[^/\\]*[_.-])?key(?:s)?(?:[_.-][^/\\]*)?|[^/\\]+\.(?:key|pem|p12|pfx))(?:$|[/\\])/i;
const SECRET_VALUE =
  /-----BEGIN [^-]*PRIVATE KEY-----|(?:^|\s)Bearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i;

export function evaluateAutoPermissionReadOnlyGate(
  input: AutoPermissionReadOnlyGateInput,
): AutoPermissionReadOnlyGateResult {
  const capabilityIds = input.approvedCapabilityIds
    .map(normalizeCapabilityId)
    .filter(Boolean);
  if (capabilityIds.length === 0) {
    return blocked('No approved capability boundary covers this action.');
  }

  if (
    input.canonicalToolName === 'Bash' ||
    input.canonicalToolName === 'RunCommand'
  ) {
    return evaluateShellRead(
      input.toolInput,
      capabilityIds,
      input.workspaceRoot,
    );
  }

  return evaluateMcpRead(
    input.canonicalToolName,
    input.toolInput,
    capabilityIds,
    input.reviewedMcpReadBindings,
  );
}

function evaluateShellRead(
  toolInput: unknown,
  capabilityIds: readonly string[],
  workspaceRoot: string | undefined,
): AutoPermissionReadOnlyGateResult {
  const command = commandText(toolInput);
  if (!command) return blocked('Shell command is missing.');
  if (SHELL_CONTROL_OR_EXPANSION.test(command)) {
    return blocked(
      'Shell controls, expansions, redirects, and globs require approval.',
    );
  }
  if (allProtectedPathMentions(command).length > 0) {
    return blocked('Protected paths require approval.');
  }

  const parsed = parseBashCommand(command);
  if (!parsed.ok || parsed.leaves.length !== 1) {
    return blocked(
      parsed.ok
        ? 'Compound shell commands require approval.'
        : `Shell command is not provably simple: ${parsed.reason}`,
    );
  }
  const leaf = parsed.leaves[0]!;
  if (leaf.redirects.length > 0 || leaf.argv.some(isSecretLikeValue)) {
    return blocked('Secret or redirected reads require approval.');
  }

  // No git in the silent set: even `git status` executes repo-configured
  // commands (core.fsmonitor), and .git/config is agent-writable. Durable
  // git rules come from the "Allow for future" prompt button instead.
  if (!['ls', 'cat'].includes(leaf.argv[0] ?? '')) {
    return blocked('Executable path is not an exact reviewed read command.');
  }
  const executable = bashExecutableName(leaf.argv[0] ?? '');
  if (executable === 'ls') {
    return evaluateFileRead(
      'list',
      leaf.argv.slice(1),
      capabilityIds,
      isLsArg,
      false,
      workspaceRoot,
    );
  }
  if (executable === 'cat') {
    return evaluateFileRead(
      'read',
      leaf.argv.slice(1),
      capabilityIds,
      isCatArg,
      true,
      workspaceRoot,
    );
  }
  return blocked(
    `Executable ${executable || '(missing)'} is not a reviewed read command.`,
  );
}

function evaluateFileRead(
  action: 'list' | 'read',
  args: readonly string[],
  capabilityIds: readonly string[],
  validArg: (arg: string) => boolean,
  requiresTarget: boolean,
  workspaceRoot: string | undefined,
): AutoPermissionReadOnlyGateResult {
  const fileArgs: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (optionsEnded || !arg.startsWith('-')) {
      fileArgs.push(arg);
    }
  }
  if (
    (requiresTarget && fileArgs.length === 0) ||
    args.some((arg) => !validArg(arg)) ||
    fileArgs.some((arg) => !isProvablyWorkspacePath(arg))
  ) {
    return blocked(`The file ${action} command shape is not provably safe.`);
  }
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    return blocked(`The file ${action} requires an absolute workspace root.`);
  }
  let resolvedWorkspaceRoot: string;
  try {
    resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    return blocked(`The file ${action} workspace root could not be resolved.`);
  }
  // This pre-execution check is sound because the runner cannot create symlinks
  // without a separately-approved write: Write/Edit create regular files, and
  // `ln -s` via Bash is not in the silent set.
  for (const fileArg of fileArgs.length > 0 ? fileArgs : ['.']) {
    let resolvedTarget: string;
    try {
      resolvedTarget = fs.realpathSync.native(
        path.resolve(resolvedWorkspaceRoot, fileArg),
      );
    } catch {
      return blocked(`The file ${action} target could not be resolved.`);
    }
    if (!isWithinPath(resolvedWorkspaceRoot, resolvedTarget)) {
      return blocked(`The resolved file ${action} target is not safe.`);
    }
    // Hidden/secret checks apply to the workspace-relative part only: the
    // root itself is host-provisioned (GANTRY_HOME may legitimately be a
    // dotted path), while everything below it is agent-influenced.
    const relativeTarget = path.relative(resolvedWorkspaceRoot, resolvedTarget);
    if (
      hasHiddenPathSegment(relativeTarget) ||
      allProtectedPathMentions(resolvedTarget).length > 0 ||
      SECRET_PATH.test(relativeTarget)
    ) {
      return blocked(`The resolved file ${action} target is not safe.`);
    }
  }
  const boundary = capabilityIds.find((id) => {
    const tokens = capabilityTokens(id);
    return (
      tokens.length === 2 &&
      FILE_CAPABILITY_DOMAINS.has(tokens[0] ?? '') &&
      (tokens.at(-1) === action || tokens.at(-1) === 'read')
    );
  });
  if (!boundary) {
    return blocked(`No approved file ${action} capability boundary matches.`);
  }
  return allowed(`Parser-proven file ${action} within ${boundary}.`);
}

function evaluateMcpRead(
  canonicalToolName: string,
  toolInput: unknown,
  capabilityIds: readonly string[],
  reviewedMcpReadBindings: readonly McpReadBinding[] | undefined,
): AutoPermissionReadOnlyGateResult {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_.-]+)$/.exec(
    canonicalToolName,
  );
  if (!match || match[1] === 'gantry') {
    return blocked('Tool family has no deterministic read-only proof.');
  }
  if (containsSecretLikeInput(toolInput)) {
    return blocked('Secret-bearing MCP reads require approval.');
  }

  const toolTokens = capabilityTokens(`${match[1]}.${match[2]}`);
  if (toolTokens.some(isSecretResourceToken)) {
    return blocked('MCP action targets a secret or credential resource.');
  }
  const reviewedBinding = reviewedMcpReadBindings?.find((binding) =>
    mcpToolPatternCovers(binding.toolPattern.trim(), canonicalToolName),
  );
  if (!reviewedBinding) {
    return blocked('MCP action lacks reviewed read-only action metadata.');
  }
  const reviewedCapability = capabilityIds.find(
    (id) => id === normalizeCapabilityId(reviewedBinding.capabilityId),
  );
  if (!reviewedCapability) {
    return blocked(
      'No approved capability boundary covers this reviewed MCP read action.',
    );
  }
  return allowed(`Reviewed MCP read action within ${reviewedCapability}.`);
}

function isLsArg(arg: string): boolean {
  return arg === '--' || !arg.startsWith('-') || LS_OPTIONS.test(arg);
}

function isCatArg(arg: string): boolean {
  return arg === '--' || !arg.startsWith('-') || CAT_OPTIONS.has(arg);
}

function isProvablyWorkspacePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('~')) return false;
  // Hidden segments (.npmrc, .netrc, .aws/…) are where credentials live;
  // they are never provably non-secret, so they always ask.
  return !hasHiddenPathSegment(value);
}

function hasHiddenPathSegment(value: string): boolean {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => segment !== '.' && segment.startsWith('.'));
}

function isWithinPath(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function containsSecretLikeInput(value: unknown, key?: string): boolean {
  if (key && isSecretInputKey(key)) return true;
  if (typeof value === 'string') {
    return isSecretLikeValue(value) || SECRET_VALUE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretLikeInput(item));
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([childKey, child]) =>
    containsSecretLikeInput(child, childKey),
  );
}

function isSecretLikeValue(value: string): boolean {
  return SECRET_PATH.test(value);
}

// Exact-match selectors that name a profile, never secret material.
const BENIGN_SELECTOR_KEYS = new Set(['credential_profile_ref']);

function isSecretInputKey(key: string): boolean {
  // Secret tokens win over id/name/ref suffixes: secretId, tokenRef, and
  // credentialId all select secret material and must ask.
  const normalized = key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  if (BENIGN_SELECTOR_KEYS.has(normalized)) return false;
  return SECRET_KEY.test(normalized);
}

function isSecretResourceToken(token: string): boolean {
  return /^(?:credential|credentials|key|keys|password|secret|secrets|token|tokens)$/.test(
    token,
  );
}

function commandText(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.cmd;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeCapabilityId(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[_-]+/g, '.');
}

function capabilityTokens(value: string): string[] {
  return normalizeCapabilityId(value).split('.').filter(Boolean);
}

function allowed(reason: string): AutoPermissionReadOnlyGateResult {
  return { allowed: true, reason };
}

function blocked(reason: string): AutoPermissionReadOnlyGateResult {
  return { allowed: false, reason };
}
