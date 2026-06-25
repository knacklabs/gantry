export interface BashCommandRedirect {
  operator: string;
  target: string;
  destructive: boolean;
}

export interface BashCommandLeaf {
  argv: string[];
  commandText: string;
  redirects: BashCommandRedirect[];
}

export type BashCommandParseResult =
  | { ok: true; leaves: BashCommandLeaf[] }
  | { ok: false; reason: string };

const UNSAFE_COMMANDS = new Set([
  '.',
  'bash',
  'builtin',
  'command',
  'coproc',
  'env',
  'eval',
  'exec',
  'find',
  'nice',
  'nohup',
  'script',
  'setsid',
  'sh',
  'source',
  'sudo',
  'timeout',
  'xargs',
]);

const STATEFUL_COMMANDS = new Set([
  'alias',
  'cd',
  'export',
  'popd',
  'pushd',
  'set',
  'umask',
  'unalias',
  'unset',
]);

const WILDCARD_SENSITIVE_COMMANDS = new Set([
  'bun',
  'deno',
  'lua',
  'node',
  'perl',
  'php',
  'python',
  'python3',
  'ruby',
  'ts-node',
  'tsx',
]);
const SAFE_SCRIPT_INTERPRETERS = new Set(['python', 'python3']);

const SHELL_KEYWORDS = new Set([
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
]);

export function parseBashCommand(command: string): BashCommandParseResult {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: 'Bash command is empty.' };
  if (trimmed.length > 4096) {
    return { ok: false, reason: 'Bash command is too long to parse safely.' };
  }
  return parseSegment(trimmed);
}

export function firstDestructiveRedirectTarget(
  command: string,
): string | undefined {
  const parsed = parseBashCommand(command);
  if (!parsed.ok) return undefined;
  for (const leaf of parsed.leaves) {
    const redirect = leaf.redirects.find((candidate) => candidate.destructive);
    if (redirect) return `${redirect.operator} ${redirect.target}`;
  }
  return undefined;
}

export function destructiveBashCommandHint(
  command: string,
): string | undefined {
  const text = command.trim();
  // ponytail: bounded prompt hint only; this is not a shell or SQL safety parser.
  if (/\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i.test(text)) {
    return 'Downloads and runs a remote script';
  }
  if (/\b(?:DROP|TRUNCATE)\s+(?:TABLE\s+)?[A-Za-z_][\w.]*/i.test(text)) {
    return 'Runs destructive SQL';
  }
  if (/\bDELETE\s+FROM\s+[A-Za-z_][\w.]*/i.test(text)) {
    return 'Runs destructive SQL';
  }
  if (/\bALTER\s+TABLE\s+[A-Za-z_][\w.]*/i.test(text)) {
    return 'Changes a database table';
  }
  const parsed = parseBashCommand(text);
  if (parsed.ok) {
    for (const leaf of parsed.leaves) {
      const commandName = executableName(leaf.argv[0] ?? '');
      if (commandName === 'rm') {
        let recursive = false;
        let force = false;
        for (const arg of leaf.argv.slice(1)) {
          if (!arg.startsWith('-') || arg === '--') continue;
          if (arg.includes('r') || arg.includes('R')) recursive = true;
          if (arg.includes('f')) force = true;
        }
        if (recursive && force) {
          return 'Removes files recursively';
        }
      }
      if (commandName === 'dd') return 'Writes raw disk data';
      if (commandName === 'mkfs' || commandName.startsWith('mkfs.')) {
        return 'Formats a filesystem';
      }
    }
  }
  if (
    /\b(?:DROP|DELETE|TRUNCATE|ALTER\s+TABLE|rm\s+-|mkfs(?:\.\w+)?|dd)\b/i.test(
      text,
    )
  ) {
    return 'Review the full command before approving';
  }
  return undefined;
}

export function bashLeafRuleContent(leaf: BashCommandLeaf): string {
  return leaf.commandText;
}

export function normalizeBashLeafRuleContent(
  leaf: BashCommandLeaf,
): string | undefined {
  const scriptRule = normalizeScriptLeafRuleContent(leaf);
  if (scriptRule) return scriptRule;
  const argv = leaf.argv;
  if (argv.length === 0) return undefined;
  const normalized = argv.map((arg) => normalizeBashArg(arg));
  return normalized.join(' ');
}

export function normalizePersistentBashRuleContent(
  ruleContent: string,
): string {
  const trimmed = ruleContent.trim();
  const parsed = parseBashCommand(trimmed);
  if (!parsed.ok || parsed.leaves.length !== 1) return trimmed;
  const leaf = parsed.leaves[0]!;
  if (leaf.redirects.length > 0) return trimmed;
  return normalizeScriptLeafRuleContent(leaf) ?? trimmed;
}

export function nonDurableBashLeafReason(
  leaf: BashCommandLeaf,
): string | undefined {
  const scriptPath = pythonScriptPathForLeaf(leaf.argv);
  if (scriptPath && !isReviewedSkillScriptPath(scriptPath)) {
    return 'Persistent RunCommand rules cannot grant host-owned Python scripts; install a reviewed skill action or approve a semantic local_cli capability instead.';
  }
  const command = executableName(leaf.argv[0] ?? '');
  if (STATEFUL_COMMANDS.has(command)) {
    return `Bash ${command} changes shell state and cannot be persisted as an independent leaf.`;
  }
  return undefined;
}

export function wildcardSensitiveBashLeafReason(
  leaf: BashCommandLeaf,
  scope: string,
): string | undefined {
  const command = executableName(leaf.argv[0] ?? '');
  const scriptPath = pythonScriptPathForLeaf(leaf.argv);
  if (scriptPath && isReviewedSkillScriptPath(scriptPath)) {
    return undefined;
  }
  if (scriptPath && scope.includes('*')) {
    return 'Bash Python script wildcard scopes are too broad for persistent approval; install a reviewed skill action or approve a semantic local_cli capability.';
  }
  if (!WILDCARD_SENSITIVE_COMMANDS.has(command) || !scope.includes('*')) {
    return undefined;
  }
  return `Bash ${command} wildcard scopes are too broad for persistent approval; use an exact command or a semantic capability.`;
}

export function bashExecutableName(command: string): string {
  return executableName(command);
}

export function formatBashArgv(argv: readonly string[]): string {
  return argv.map(quoteBashArg).join(' ');
}

/**
 * Best-effort, human-readable gist of which programs a command runs, for
 * permission prompts ("npm, git"). Returns the ordered distinct program names,
 * or undefined when the command can't be parsed safely (the caller then falls
 * back to showing the raw command block instead).
 */
export function summarizeBashCommandPrograms(
  command: string,
): string | undefined {
  const parsed = parseBashCommand(command);
  if (!parsed.ok || parsed.leaves.length === 0) return undefined;
  const programs: string[] = [];
  for (const leaf of parsed.leaves) {
    const name = executableName(leaf.argv[0] ?? '');
    if (name && programs.at(-1) !== name) programs.push(name);
  }
  if (programs.length === 0) return undefined;
  const shown = programs.slice(0, 4);
  const overflow =
    programs.length > shown.length
      ? `, +${programs.length - shown.length} more`
      : '';
  return `${shown.join(', ')}${overflow}`;
}

function parseSegment(command: string): BashCommandParseResult {
  const leaves: BashCommandLeaf[] = [];
  let tokens: string[] = [];
  let redirects: BashCommandRedirect[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flushToken = () => {
    if (!token) return;
    tokens.push(token);
    token = '';
  };

  const flushLeaf = (): BashCommandParseResult | null => {
    flushToken();
    if (tokens.length === 0 && redirects.length === 0) return null;
    const leaf = buildLeaf(tokens, redirects);
    if (!leaf.ok) return leaf;
    leaves.push(leaf.leaf);
    tokens = [];
    redirects = [];
    return null;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      if (quote === "'") {
        token += ch;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && (ch === '`' || ch === '$')) {
        return {
          ok: false,
          reason:
            'Bash command uses shell expansion that cannot be persisted safely.',
        };
      }
      token += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === '`' || ch === '$') {
      return {
        ok: false,
        reason:
          'Bash command uses shell expansion that cannot be persisted safely.',
      };
    }

    if (ch === '{' || ch === '}') {
      return {
        ok: false,
        reason: 'Bash command groups and functions are not supported.',
      };
    }

    if (ch === '(') {
      if (token.trim()) {
        return {
          ok: false,
          reason:
            'Bash process substitution and function syntax are not supported.',
        };
      }
      const end = findMatchingParen(command, i);
      if (end < 0) {
        return { ok: false, reason: 'Bash command has unmatched parentheses.' };
      }
      const nested = parseSegment(command.slice(i + 1, end));
      if (!nested.ok) return nested;
      leaves.push(...nested.leaves);
      i = end;
      continue;
    }

    if (ch === ')') {
      return { ok: false, reason: 'Bash command has unmatched parentheses.' };
    }

    if (ch === '&') {
      if (next !== '&') {
        return {
          ok: false,
          reason: 'Background Bash execution is not supported.',
        };
      }
      const flushed = flushLeaf();
      if (flushed) return flushed;
      i += 1;
      continue;
    }

    if (ch === '|' || ch === ';' || ch === '\n') {
      const flushed = flushLeaf();
      if (flushed) return flushed;
      if (ch === '|' && next === '|') i += 1;
      continue;
    }

    if (ch === '<' || ch === '>') {
      const parsedRedirect = parseRedirect(command, i, token);
      if (!parsedRedirect.ok) return parsedRedirect;
      token = '';
      redirects.push(parsedRedirect.redirect);
      i = parsedRedirect.nextIndex;
      continue;
    }

    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }

    token += ch;
  }

  if (escaped)
    return { ok: false, reason: 'Bash command has dangling escape.' };
  if (quote) return { ok: false, reason: 'Bash command has unmatched quotes.' };
  const flushed = flushLeaf();
  if (flushed) return flushed;
  if (leaves.length === 0) {
    return { ok: false, reason: 'Bash command has no executable leaves.' };
  }
  return { ok: true, leaves };
}

function parseRedirect(
  command: string,
  index: number,
  currentToken: string,
):
  | {
      ok: true;
      redirect: BashCommandRedirect;
      nextIndex: number;
    }
  | { ok: false; reason: string } {
  const operatorChar = command[index];
  let fd: string | undefined;
  if (/^\d+$/.test(currentToken)) fd = currentToken;
  else if (currentToken) {
    return {
      ok: false,
      reason: 'Bash redirection must be separated from command arguments.',
    };
  }

  let operator = `${fd ?? ''}${operatorChar}`;
  let cursor = index + 1;
  if (operatorChar === '>' && command[cursor] === '>') {
    operator += '>';
    cursor += 1;
  }
  while (/\s/.test(command[cursor] ?? '')) cursor += 1;
  if (command[cursor] === '&') {
    const dupStart = cursor;
    cursor += 1;
    if (command[cursor] === '-') {
      cursor += 1;
    } else {
      const fdStart = cursor;
      while (/\d/.test(command[cursor] ?? '')) cursor += 1;
      if (cursor === fdStart) {
        return {
          ok: false,
          reason: 'Bash redirection file descriptor target missing.',
        };
      }
    }
    const target = command.slice(dupStart, cursor).trim();
    return {
      ok: true,
      redirect: {
        operator,
        target,
        destructive: false,
      },
      nextIndex: cursor - 1,
    };
  }
  const targetStart = cursor;
  while (
    cursor < command.length &&
    !/\s/.test(command[cursor]) &&
    !['&', '|', ';', '\n', '(', ')', '<', '>'].includes(command[cursor])
  ) {
    cursor += 1;
  }
  const target = command.slice(targetStart, cursor).trim();
  if (!target) return { ok: false, reason: 'Bash redirection target missing.' };
  if (target.includes('$') || target.includes('`')) {
    return {
      ok: false,
      reason: 'Bash redirection target uses unsupported expansion.',
    };
  }
  return {
    ok: true,
    redirect: {
      operator,
      target,
      destructive: isDestructiveRedirect(operator, target),
    },
    nextIndex: cursor - 1,
  };
}

function buildLeaf(
  argv: string[],
  redirects: BashCommandRedirect[],
): { ok: true; leaf: BashCommandLeaf } | { ok: false; reason: string } {
  if (argv.length === 0) {
    return {
      ok: false,
      reason: 'Bash redirection without a command is not supported.',
    };
  }
  const command = argv[0];
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) {
    return {
      ok: false,
      reason: 'Bash environment assignments are not supported.',
    };
  }
  if (SHELL_KEYWORDS.has(command)) {
    return { ok: false, reason: `Bash keyword ${command} is not supported.` };
  }
  const metaReason = unsafeMetaExecutorReason(argv);
  if (metaReason) return { ok: false, reason: metaReason };
  return {
    ok: true,
    leaf: {
      argv,
      commandText: argv.join(' '),
      redirects,
    },
  };
}

function unsafeMetaExecutorReason(argv: string[]): string | undefined {
  const command = executableName(argv[0]);
  if (!UNSAFE_COMMANDS.has(command)) return undefined;
  if ((command === 'sh' || command === 'bash') && argv.includes('-c')) {
    return `${command} -c is not supported for persistent Bash approval.`;
  }
  if (command === 'find' && argv.includes('-exec')) {
    return 'find -exec is not supported for persistent Bash approval.';
  }
  return `Bash meta-executor ${command} is not supported for persistent approval.`;
}

function executableName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed.includes('/')) return trimmed;
  return trimmed.split('/').filter(Boolean).at(-1) ?? trimmed;
}

function isDestructiveRedirect(operator: string, target: string): boolean {
  if (operator.startsWith('<')) return false;
  if ((operator === '2>' || operator === '2>>') && target === '/dev/null') {
    return false;
  }
  return operator.includes('>');
}

function findMatchingParen(command: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = openIndex; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = quote !== "'";
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function normalizeBashArg(arg: string): string {
  const url = normalizeUrlArg(arg);
  if (url) return url;
  if (isVolatileGitRef(arg)) return '*';
  return arg;
}

function quoteBashArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function normalizeScriptLeafRuleContent(
  leaf: BashCommandLeaf,
): string | undefined {
  const argv = leaf.argv;
  if (argv.length === 0) return undefined;
  const scriptArg = pythonScriptPathForLeaf(argv);
  if (!scriptArg || !isReviewedSkillScriptPath(scriptArg)) return undefined;
  return `${normalizeBashArg(scriptArg)} *`;
}

function isPythonScriptPath(value: string): boolean {
  return value.endsWith('.py');
}

function pythonScriptPathForLeaf(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  const executable = executableName(argv[0] ?? '');
  const scriptArg = SAFE_SCRIPT_INTERPRETERS.has(executable)
    ? argv[1]
    : argv[0];
  if (
    !scriptArg ||
    scriptArg.startsWith('-') ||
    !isPythonScriptPath(scriptArg)
  ) {
    return undefined;
  }
  return scriptArg;
}

function isReviewedSkillScriptPath(value: string): boolean {
  const normalized = value.replace(/^\.\/+/, '');
  return normalized.startsWith('skills/');
}

function normalizeUrlArg(arg: string): string | undefined {
  try {
    const url = new URL(arg);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return undefined;
  }
}

function isVolatileGitRef(arg: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(arg) || /^HEAD~\d+$/.test(arg);
}
