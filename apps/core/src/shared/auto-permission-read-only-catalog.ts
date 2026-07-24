// Argument-shape-agnostic reads that never touch a workspace file (they print
// literals, identity, or transform stdin). Any file/secret they might name is
// still caught by the whole-command protected-path and per-leaf secret scans.
// `env`/`printenv` are deliberately EXCLUDED: they dump the process
// environment, which can hold live credentials — auto-allowing them would
// contradict the gate that blocks reading `.env`.
export const BARE_SAFE_EXECUTABLES = new Set([
  'basename',
  'date',
  'dirname',
  'echo',
  'expr',
  'false',
  'id',
  'seq',
  'tr',
  'true',
  'uname',
  'whoami',
]);

// Read stdin or a file operand; confined the same way as cat/grep.
export const GENERIC_READ_EXECUTABLES = new Set([
  'cut',
  'nl',
  'paste',
  'rev',
  'sort',
  'uniq',
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'log',
  'show',
  'status',
]);
const GIT_SAFE_GLOBAL_OPTIONS = new Set([
  '--literal-pathspecs',
  '--no-optional-locks',
  '--no-pager',
  '--no-replace-objects',
]);
const GIT_BRANCH_READ_OPTIONS =
  /^(?:-a|-r|-v|-vv|--list|--all|--remotes|--verbose|--color(?:=\w+)?|--no-color)$/;

// -exec/-delete/etc. run or mutate; -follow/-L/-H escape workspace confinement.
export const FIND_UNSAFE_PRIMARY =
  /^-(?:exec|execdir|okdir|ok|delete|fprintf|fprint0|fprint|fls|follow|L|H)$/;
export const FIND_GLOBAL_OPTION = /^-(?:O\d*|P|D|f)$/;

// Read-only git subset (status/log/diff/show/read-only branch). Rejects `-c`,
// `-C`, `--git-dir`, `--exec-path`, output/exec options, every write/network
// subcommand, and any hidden/secret pathspec (e.g. `git show HEAD:.npmrc`).
export function gitReadOnly(
  args: readonly string[],
  capabilityIds: readonly string[],
): boolean {
  if (!capabilityIds.some((id) => capabilityTokens(id)[0] === 'git')) {
    return false;
  }
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) {
    if (!GIT_SAFE_GLOBAL_OPTIONS.has(args[index]!)) return false;
    index += 1;
  }
  const subcommand = args[index];
  if (!subcommand || !GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
  const rest = args.slice(index + 1);
  for (const arg of rest) {
    if (arg === '-c' || /^(?:-o|-O|--output|--exec)/.test(arg)) return false;
    const pathPart = arg.includes(':') ? arg.slice(arg.indexOf(':') + 1) : arg;
    if (hasHiddenPathSegment(pathPart)) return false;
  }
  if (subcommand === 'branch') {
    return rest.every((arg) => GIT_BRANCH_READ_OPTIONS.test(arg));
  }
  return true;
}

// Only `sed -n <script> [file...]` (print-only). Any other flag (`-i`, `-e`,
// `-f`, `--in-place`) blocks, as does a script naming a write/exec command.
export function sedReadFileArgs(args: readonly string[]): string[] | undefined {
  const flags = args.filter((arg) => arg.startsWith('-'));
  if (!flags.includes('-n') || flags.some((flag) => flag !== '-n')) {
    return undefined;
  }
  const nonFlags = args.filter((arg) => !arg.startsWith('-'));
  const script = nonFlags[0] ?? '';
  // Conservative: a script char of w/W (write) or e (execute) blocks, even when
  // it is only regex text — the safe cost is an extra prompt.
  if (/[wWe]/.test(script)) return undefined;
  return nonFlags.slice(1);
}

// stdin-or-file transforms: skip option flags, reject output flags, confine the
// rest. Over-rejects separated option VALUES (they resolve to non-files and
// block), which only costs an extra prompt.
export function genericReadFileArgs(
  args: readonly string[],
): string[] | undefined {
  const fileArgs: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-')) {
      if (/^(?:-o|-w|--output)/.test(arg)) return undefined;
    } else {
      fileArgs.push(arg);
    }
  }
  return fileArgs;
}

export function hasHiddenPathSegment(value: string): boolean {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => segment !== '.' && segment.startsWith('.'));
}

export function normalizeCapabilityId(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[_-]+/g, '.');
}

export function capabilityTokens(value: string): string[] {
  return normalizeCapabilityId(value).split('.').filter(Boolean);
}
