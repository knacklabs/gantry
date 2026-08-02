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
