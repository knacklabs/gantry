import {
  bashExecutableName,
  parseBashCommandForHardBoundaryAnalysis,
} from './bash-command-parser.js';

const CONTENT_INTERPRETERS = new Set([
  'bash',
  'bun',
  'dash',
  'deno',
  'lua',
  'node',
  'perl',
  'php',
  'python',
  'python3',
  'ruby',
  'sh',
  'source',
  'ts-node',
  'tsx',
  'zsh',
]);
const INLINE_META_EXECUTORS = new Set(['.', 'eval']);
const EXECUTION_WRAPPERS = new Set([
  'command',
  'env',
  'exec',
  'find',
  'nice',
  'nohup',
  'setsid',
  'sudo',
  'timeout',
  'xargs',
]);
const INLINE_INTERPRETER_FLAGS = new Set([
  '-c',
  '--command',
  '-e',
  '--eval',
  '--evaluate',
]);
const SCRIPT_FILE_SUFFIX = /\.(?:bash|cjs|js|lua|mjs|php|pl|py|rb|sh|ts)$/i;
const REVIEWED_EXECUTION_PATH_PREFIX = 'skills/';
const STABLE_EXECUTABLE_PATH_PREFIXES = [
  '/bin/',
  '/opt/homebrew/bin/',
  '/usr/bin/',
  '/usr/local/bin/',
] as const;

export function isRemoteContentExecutionBashCommand(command: string): boolean {
  const parsed = parseBashCommandForHardBoundaryAnalysis(command);
  if (!parsed.ok) return false;
  if (parsed.piped) return true;
  if (
    parsed.leaves.some((leaf) =>
      leaf.redirects.some((redirect) => redirect.destructive),
    )
  ) {
    return true;
  }
  for (const leaf of parsed.leaves) {
    const argv = executionArgv(leaf.argv);
    const executable = bashExecutableName(argv[0] ?? '');
    if (INLINE_META_EXECUTORS.has(executable)) return true;
    if (CONTENT_INTERPRETERS.has(executable)) {
      if (argv.some((arg) => INLINE_INTERPRETER_FLAGS.has(arg))) {
        return true;
      }
      const target = interpreterFileTarget(argv);
      if (target && isUnreviewedExecutionPath(target)) return true;
    }
    const executablePath = argv[0] ?? '';
    if (isUnreviewedExecutablePath(executablePath)) return true;
  }
  return false;
}

function executionArgv(argv: readonly string[]): readonly string[] {
  const wrapper = bashExecutableName(argv[0] ?? '');
  if (!EXECUTION_WRAPPERS.has(wrapper)) return argv;
  const nestedInterpreter = argv.findIndex(
    (arg, index) =>
      index > 0 && CONTENT_INTERPRETERS.has(bashExecutableName(arg)),
  );
  if (nestedInterpreter > 0) return argv.slice(nestedInterpreter);
  const nestedExecutable = argv.findIndex(
    (arg, index) => index > 0 && isUnreviewedExecutablePath(arg),
  );
  return nestedExecutable > 0 ? argv.slice(nestedExecutable) : argv;
}

function interpreterFileTarget(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '-m' || arg === '--module') return undefined;
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
}

function isUnreviewedExecutionPath(value: string): boolean {
  const normalized = value.replace(/^\.\/+/, '');
  if (normalized.startsWith(REVIEWED_EXECUTION_PATH_PREFIX)) return false;
  return (
    value === '-' ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.includes('/') ||
    SCRIPT_FILE_SUFFIX.test(value)
  );
}

function isUnreviewedExecutablePath(value: string): boolean {
  const normalized = value.replace(/^\.\/+/, '');
  if (normalized.startsWith(REVIEWED_EXECUTION_PATH_PREFIX)) return false;
  if (!value.includes('/')) return SCRIPT_FILE_SUFFIX.test(value);
  return !STABLE_EXECUTABLE_PATH_PREFIXES.some((prefix) =>
    value.startsWith(prefix),
  );
}
