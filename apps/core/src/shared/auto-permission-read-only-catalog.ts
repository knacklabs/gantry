// Argument-shape-agnostic reads that never touch a workspace file (they print
// literals, identity, or transform stdin). Any file/secret they might name is
// still caught by the whole-command protected-path and per-leaf secret scans.
// `env`/`printenv` are deliberately EXCLUDED: they dump the process
// environment, which can hold live credentials — auto-allowing them would
// contradict the gate that blocks reading `.env`.
export const BARE_SAFE_EXECUTABLES = new Set([
  'basename',
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
const GIT_STATUS_READ_OPTIONS =
  /^(?:-s|-b|--short|--branch|--porcelain(?:=v[12])?|--long|--show-stash|--ignored(?:=\w+)?|--untracked-files(?:=\w+)?|--ahead-behind|--no-ahead-behind|--renames|--no-renames|--find-renames(?:=\d+%)?)$/;
const GIT_LOG_READ_OPTIONS =
  /^(?:--oneline|--graph|--stat|--shortstat|--numstat|--name-only|--name-status|--abbrev-commit|--decorate(?:=\w+)?|--no-decorate|--all|--branches(?:=[A-Za-z0-9._/-]+)?|--tags(?:=[A-Za-z0-9._/-]+)?|--remotes(?:=[A-Za-z0-9._/-]+)?|--first-parent|--merges|--no-merges|-n\d+|--max-count=\d+|--skip=\d+|--since=[^/]+|--until=[^/]+|--author=[^/]+|--grep=[^/]+|--format=[^/]+|--pretty=[^/]+|--color(?:=\w+)?|--no-color)$/;
const GIT_DIFF_READ_OPTIONS =
  /^(?:--cached|--staged|--stat|--shortstat|--numstat|--name-only|--name-status|--check|--exit-code|--quiet|--minimal|--patience|--histogram|--word-diff(?:=\w+)?|-U\d+|--unified=\d+|--color(?:=\w+)?|--no-color)$/;
const GIT_SHOW_READ_OPTIONS =
  /^(?:--oneline|--stat|--shortstat|--numstat|--name-only|--name-status|--abbrev-commit|--decorate(?:=\w+)?|--no-decorate|--format=[^/]+|--pretty=[^/]+|-U\d+|--unified=\d+|--color(?:=\w+)?|--no-color)$/;
const GIT_REVISION = /^[A-Za-z0-9_@{}^~:+./-]+$/;

// -exec/-delete/etc. run or mutate; -follow/-L/-H escape workspace confinement.
export const FIND_UNSAFE_PRIMARY =
  /^-(?:exec|execdir|okdir|ok|delete|fprintf|fprint0|fprint|fls|follow|L|H|files0-from|anewer|cnewer|newer(?:[A-Za-z]{2})?|samefile)$/;
export const FIND_GLOBAL_OPTION = /^-(?:O\d*|P|D|f)$/;

// Read-only git subset (status/log/diff/show/read-only branch). Each
// subcommand has a strict display/read option allowlist: helper execution,
// config overrides, no-index file reads, output files, external directories,
// and unknown options all fail closed.
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
  if (subcommand === 'branch') {
    return rest.every((arg) => GIT_BRANCH_READ_OPTIONS.test(arg));
  }
  if (subcommand === 'status') {
    return gitReadArgs(rest, GIT_STATUS_READ_OPTIONS, false);
  }
  if (subcommand === 'log') {
    return gitReadArgs(rest, GIT_LOG_READ_OPTIONS, true);
  }
  if (subcommand === 'diff') {
    return gitReadArgs(rest, GIT_DIFF_READ_OPTIONS, true);
  }
  return gitReadArgs(rest, GIT_SHOW_READ_OPTIONS, true);
}

// Only `sed -n <script> [file...]` (print-only). Any other flag (`-i`, `-e`,
// `-f`, `--in-place`) blocks, as does a script naming a read/write/exec command.
export function sedReadFileArgs(args: readonly string[]): string[] | undefined {
  const flags = args.filter((arg) => arg.startsWith('-'));
  if (!flags.includes('-n') || flags.some((flag) => flag !== '-n')) {
    return undefined;
  }
  const nonFlags = args.filter((arg) => !arg.startsWith('-'));
  const script = nonFlags[0] ?? '';
  // Conservative: a script char of w/W (write), e (execute), or r/R (read an
  // additional file) blocks, even when it is only regex text. The safe cost is
  // an extra prompt.
  if (/[rRwWe]/.test(script)) return undefined;
  return nonFlags.slice(1);
}

// stdin-or-file transforms with per-executable option allowlists. Unknown
// options fail closed; uniq is limited to one input because its second
// positional operand is an output file.
export function genericReadFileArgs(
  executable: string,
  args: readonly string[],
): string[] | undefined {
  const fileArgs: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      const valueKind = genericReadOptionValue(executable, arg);
      if (valueKind === undefined) return undefined;
      if (valueKind) {
        const value = args[index + 1];
        if (!value || (valueKind === 'number' && !/^\d+$/.test(value))) {
          return undefined;
        }
        index += 1;
      }
    } else {
      fileArgs.push(arg);
    }
  }
  if (executable === 'uniq' && fileArgs.length > 1) return undefined;
  return fileArgs;
}

function gitReadArgs(
  args: readonly string[],
  safeOption: RegExp,
  revisionsAllowed: boolean,
): boolean {
  let pathspecs = false;
  for (const arg of args) {
    if (!pathspecs && arg === '--') {
      pathspecs = true;
      continue;
    }
    if (!pathspecs && arg.startsWith('-')) {
      if (!safeOption.test(arg)) return false;
      continue;
    }
    if (pathspecs || !revisionsAllowed) {
      if (!isSafeGitPathspec(arg)) return false;
      continue;
    }
    if (
      !GIT_REVISION.test(arg) ||
      pathLikeAbsolute(arg) ||
      hasHiddenPathSegment(
        arg.includes(':') ? arg.slice(arg.indexOf(':') + 1) : arg,
      )
    ) {
      return false;
    }
  }
  return true;
}

function isSafeGitPathspec(value: string): boolean {
  return (
    Boolean(value) &&
    !pathLikeAbsolute(value) &&
    !value
      .replaceAll('\\', '/')
      .split('/')
      .some((segment) => segment === '..' || segment.startsWith('.'))
  );
}

function pathLikeAbsolute(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function genericReadOptionValue(
  executable: string,
  option: string,
): false | 'string' | 'number' | undefined {
  if (executable === 'cut') {
    if (
      /^-[sz]+$/.test(option) ||
      /^--(?:complement|only-delimited|zero-terminated)$/.test(option) ||
      /^-[bcdf].+/.test(option) ||
      /^--(?:bytes|characters|delimiter|fields|output-delimiter)=.+/.test(
        option,
      )
    ) {
      return false;
    }
    if (
      /^-[bcdf]$/.test(option) ||
      /^--(?:bytes|characters|delimiter|fields|output-delimiter)$/.test(option)
    ) {
      return 'string';
    }
    return undefined;
  }
  if (executable === 'nl') return undefined;
  if (executable === 'paste') {
    if (
      /^-[sz]+$/.test(option) ||
      /^--(?:serial|zero-terminated)$/.test(option) ||
      /^-d.+/.test(option) ||
      /^--delimiters=.+/.test(option)
    ) {
      return false;
    }
    if (option === '-d' || option === '--delimiters') return 'string';
    return undefined;
  }
  if (executable === 'rev') return undefined;
  if (executable === 'sort') {
    if (
      /^-[bdfghinMRrsuVz]+$/.test(option) ||
      /^-(?:k|t).+/.test(option) ||
      /^--(?:dictionary-order|ignore-case|ignore-nonprinting|general-numeric-sort|human-numeric-sort|month-sort|numeric-sort|reverse|stable|unique|version-sort|zero-terminated|check(?:=\w+)?|key=.+|field-separator=.+)$/.test(
        option,
      )
    ) {
      return false;
    }
    if (option === '-k' || option === '-t') return 'string';
    return undefined;
  }
  if (executable === 'uniq') {
    if (
      /^-[cduiz]+$/.test(option) ||
      /^-[fsw]\d+$/.test(option) ||
      /^--(?:count|repeated|unique|ignore-case|zero-terminated|skip-fields=\d+|skip-chars=\d+|check-chars=\d+)$/.test(
        option,
      )
    ) {
      return false;
    }
    if (/^-[fsw]$/.test(option)) return 'number';
    return undefined;
  }
  return undefined;
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
