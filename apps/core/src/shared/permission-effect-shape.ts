import {
  bashExecutableName,
  type BashCommandLeaf,
} from './bash-command-parser.js';
import {
  BARE_SAFE_EXECUTABLES,
  GENERIC_READ_EXECUTABLES,
  genericReadFileArgs,
  hasHiddenPathSegment,
  sedReadFileArgs,
} from './auto-permission-read-only-catalog.js';

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

export enum PermissionEffectShape {
  ReadOnlyCommand = 'read_only_command',
  FileRead = 'file_read',
  NotReadOnly = 'not_read_only',
}

export type PermissionEffectShapeResult =
  | {
      kind: PermissionEffectShape.ReadOnlyCommand;
      executable: string;
      targets: readonly string[];
    }
  | {
      kind: PermissionEffectShape.FileRead;
      action: 'list' | 'read';
      targets: readonly string[];
      requiresTarget: boolean;
    }
  | {
      kind: PermissionEffectShape.NotReadOnly;
      reason: string;
    };

export function classifyPermissionEffectShape(
  leaf: BashCommandLeaf,
  context: { stdinOk: boolean },
): PermissionEffectShapeResult {
  const executable = bashExecutableName(leaf.argv[0] ?? '');
  if (leaf.argv[0] !== executable) {
    return notReadOnly(
      'Executable path is not an exact reviewed read command.',
    );
  }
  const args = leaf.argv.slice(1);

  if (BARE_SAFE_EXECUTABLES.has(executable)) {
    return {
      kind: PermissionEffectShape.ReadOnlyCommand,
      executable,
      targets: [],
    };
  }
  if (executable === 'sed') {
    const fileArgs = sedReadFileArgs(args);
    return fileArgs
      ? fileRead('read', fileArgs, !context.stdinOk)
      : blockedReadShape('read');
  }
  if (executable === 'ls') {
    const fileArgs = collectPlainFileArgs(args, isLsArg);
    return fileArgs
      ? fileRead('list', fileArgs, false)
      : blockedReadShape('list');
  }
  if (executable === 'cat') {
    const fileArgs = collectPlainFileArgs(args, isCatArg);
    return fileArgs
      ? fileRead('read', fileArgs, !context.stdinOk)
      : blockedReadShape('read');
  }
  if (executable === 'pwd') {
    return args.every((arg) => /^-[LP]$/.test(arg))
      ? fileRead('read', ['.'], false)
      : blockedReadShape('read');
  }
  if (executable === 'which') {
    const names = args.filter((arg) => !/^-(?:a|s)$/.test(arg));
    return names.length > 0 &&
      !args.some((arg) => arg.startsWith('-') && !/^-(?:a|s)$/.test(arg)) &&
      !names.some((name) => !/^[A-Za-z0-9_.+-]+$/.test(name))
      ? fileRead('read', ['.'], false)
      : blockedReadShape('read');
  }
  if (executable === 'grep') {
    const fileArgs = grepFileArgs(args);
    return fileArgs
      ? fileRead('read', fileArgs, !context.stdinOk)
      : blockedReadShape('read');
  }
  if (GENERIC_READ_EXECUTABLES.has(executable)) {
    const fileArgs = genericReadFileArgs(executable, args);
    return fileArgs
      ? fileRead('read', fileArgs, false)
      : blockedReadShape('read');
  }
  const fileArgs = simpleReadFileArgs(executable, args);
  if (fileArgs) {
    return fileRead('read', fileArgs, executable !== 'du' && !context.stdinOk);
  }
  return notReadOnly(
    `Executable ${executable || '(missing)'} is not a reviewed read command.`,
  );
}

function fileRead(
  action: 'list' | 'read',
  targets: readonly string[],
  requiresTarget: boolean,
): PermissionEffectShapeResult {
  return (requiresTarget && targets.length === 0) ||
    targets.some((target) => !isProvablyWorkspacePath(target))
    ? blockedReadShape(action)
    : {
        kind: PermissionEffectShape.FileRead,
        action,
        targets,
        requiresTarget,
      };
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
    } else if (/^-[qvz]+$|^-[nc]?\d+$|^--(?:bytes|lines)=\d+$/.test(arg)) {
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
): PermissionEffectShapeResult {
  return notReadOnly(`The file ${action} command shape is not provably safe.`);
}

function notReadOnly(reason: string): PermissionEffectShapeResult {
  return { kind: PermissionEffectShape.NotReadOnly, reason };
}
