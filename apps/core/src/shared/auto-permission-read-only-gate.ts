import fs from 'fs';
import path from 'path';

import {
  bashExecutableName,
  parseBashCommand,
  type BashCommandParseResult,
} from './bash-command-parser.js';
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
// -H/-L remain excluded because they follow symlinks beyond the checked target.
const LS_OPTIONS = /^-(?:[1ACFRSTUabcdfghiklmnopqrstux@])+$/;
const LS_LONG_OPTIONS =
  /^--(?:all|almost-all|classify|directory|file-type|group-directories-first|human-readable|inode|long|numeric-uid-gid|recursive|reverse|size|color(?:=\w+)?|sort=\w+|time=\w+)$/;
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

  const parsed = parseGateCommand(command);
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

  const executable = bashExecutableName(leaf.argv[0] ?? '');
  if (leaf.argv[0] !== executable) {
    return blocked('Executable path is not an exact reviewed read command.');
  }
  const args = leaf.argv.slice(1);
  if (executable === 'ls') {
    const fileArgs = collectPlainFileArgs(args, isLsArg);
    if (!fileArgs) return blockedReadShape('list');
    return evaluateFileRead(
      'list',
      fileArgs,
      capabilityIds,
      false,
      workspaceRoot,
    );
  }
  if (executable === 'cat') {
    const fileArgs = collectPlainFileArgs(args, isCatArg);
    if (!fileArgs) return blockedReadShape('read');
    return evaluateFileRead(
      'read',
      fileArgs,
      capabilityIds,
      true,
      workspaceRoot,
    );
  }
  if (executable === 'pwd') {
    if (!args.every((arg) => /^-[LP]$/.test(arg))) {
      return blockedReadShape('read');
    }
    return evaluateFileRead('read', ['.'], capabilityIds, false, workspaceRoot);
  }
  if (executable === 'which') {
    const names = args.filter((arg) => !/^-(?:a|s)$/.test(arg));
    if (
      names.length === 0 ||
      args.some((arg) => arg.startsWith('-') && !/^-(?:a|s)$/.test(arg)) ||
      names.some((name) => !/^[A-Za-z0-9_.+-]+$/.test(name))
    ) {
      return blockedReadShape('read');
    }
    return evaluateFileRead('read', ['.'], capabilityIds, false, workspaceRoot);
  }
  if (executable === 'grep') {
    const fileArgs = grepFileArgs(args);
    if (!fileArgs) return blockedReadShape('read');
    return evaluateFileRead(
      'read',
      fileArgs,
      capabilityIds,
      true,
      workspaceRoot,
    );
  }
  const fileArgs = simpleReadFileArgs(executable, args);
  if (fileArgs) {
    return evaluateFileRead(
      'read',
      fileArgs,
      capabilityIds,
      executable !== 'du',
      workspaceRoot,
    );
  }
  return blocked(
    `Executable ${executable || '(missing)'} is not a reviewed read command.`,
  );
}

function evaluateFileRead(
  action: 'list' | 'read',
  fileArgs: readonly string[],
  capabilityIds: readonly string[],
  requiresTarget: boolean,
  workspaceRoot: string | undefined,
): AutoPermissionReadOnlyGateResult {
  if (
    (requiresTarget && fileArgs.length === 0) ||
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
  return (
    arg === '--' ||
    !arg.startsWith('-') ||
    LS_OPTIONS.test(arg) ||
    LS_LONG_OPTIONS.test(arg)
  );
}

function isCatArg(arg: string): boolean {
  return arg === '--' || !arg.startsWith('-') || CAT_OPTIONS.has(arg);
}

function isProvablyWorkspacePath(value: string): boolean {
  if (!value || value.startsWith('~')) return false;
  // Hidden segments (.npmrc, .netrc, .aws/…) are where credentials live;
  // they are never provably non-secret, so they always ask.
  return !hasHiddenPathSegment(value);
}

function parseGateCommand(command: string): BashCommandParseResult {
  return parseBashCommand(command);
}

function collectPlainFileArgs(
  args: readonly string[],
  validArg: (arg: string) => boolean,
): string[] | undefined {
  const fileArgs: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!validArg(arg)) {
      return undefined;
    } else if (optionsEnded || !arg.startsWith('-')) {
      fileArgs.push(arg);
    }
  }
  return fileArgs;
}

function simpleReadFileArgs(
  executable: string,
  args: readonly string[],
): string[] | undefined {
  const options: Record<string, RegExp> = {
    stat: /^-[Flnqrstx]+$/,
    file: /^-[bikLNsvz]+$|^--(?:brief|dereference|mime|mime-type|special-files)$/,
    wc: /^-[clmwL]+$|^--(?:bytes|chars|lines|max-line-length|words)$/,
    du: /^-[achksx]+$|^-d\d+$|^--max-depth=\d+$/,
    df: /^-[hiklmPT]+$/,
  };
  const option = options[executable];
  if (option) {
    return collectPlainFileArgs(
      args,
      (arg) => arg === '--' || !arg.startsWith('-') || option.test(arg),
    );
  }
  if (executable !== 'head' && executable !== 'tail') return undefined;
  const fileArgs: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (optionsEnded || !arg.startsWith('-')) {
      fileArgs.push(arg);
    } else if (/^-[qvz]+$|^-[nc]\d+$|^--(?:bytes|lines)=\d+$/.test(arg)) {
      continue;
    } else if (/^(?:-[nc]|--bytes|--lines)$/.test(arg)) {
      if (!/^\d+$/.test(args[index + 1] ?? '')) return undefined;
      index += 1;
    } else {
      return undefined;
    }
  }
  return fileArgs;
}

function grepFileArgs(args: readonly string[]): string[] | undefined {
  const noValueOption =
    /^-(?:[EFGHILTZabchilnoqsvwxyz]+)$|^--(?:basic-regexp|extended-regexp|fixed-strings|ignore-case|line-number|no-messages|only-matching|quiet|text|word-regexp|with-filename)$/;
  const valueOption =
    /^(?:-A|-B|-C|-m|--after-context|--before-context|--context|--max-count)$/;
  const fileArgs: string[] = [];
  let patternSeen = false;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && /^(?:-e|--regexp)$/.test(arg)) {
      if (!args[index + 1]) return undefined;
      patternSeen = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && /^-e.+/.test(arg)) {
      patternSeen = true;
      continue;
    }
    if (!optionsEnded && /^(?:-d.*|--directories(?:=.*)?)$/.test(arg)) {
      return undefined;
    }
    if (!optionsEnded && valueOption.test(arg)) {
      if (!args[index + 1]) return undefined;
      index += 1;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (!noValueOption.test(arg)) return undefined;
      continue;
    }
    if (!patternSeen) patternSeen = true;
    else fileArgs.push(arg);
  }
  return patternSeen && fileArgs.length > 0 ? fileArgs : undefined;
}

function blockedReadShape(
  action: 'list' | 'read',
): AutoPermissionReadOnlyGateResult {
  return blocked(`The file ${action} command shape is not provably safe.`);
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
