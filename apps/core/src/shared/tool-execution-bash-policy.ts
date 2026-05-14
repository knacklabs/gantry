import {
  firstProtectedPathMention,
  hasProtectedPathReference,
  PROVIDER_CLI_NAME,
} from './tool-execution-protected-paths.js';

const BASH_MUTATION_VERB_PATTERN = new RegExp(
  [
    String.raw`\b(?:cat\s+>|tee(?:\s+-a)?\s+|sponge\s+)`,
    String.raw`\b(?:rm\s+(?:-[^\s]+\s+)*|mv\s+|cp\s+|touch\s+|mkdir\s+(?:-[^\s]+\s+)*)`,
    String.raw`\b(?:install\s+|truncate\s+|rsync\s+|tar\s+.*\b(?:-C|--directory)\b|dd\s+.*\bof=)`,
    String.raw`\b(?:sed\s+(?:-[^\s]+\s+)*-i|perl\s+(?:-[^\s]+\s+)*-[0-9A-Za-z]*i|perl\s+.*open\([^)]*['"]>)`,
    String.raw`\b(?:python3?\s+.*(?:write_text|write\(|open\([^)]*['"]w)|ruby\s+.*(?:File\.write|open\([^)]*['"]w)|node\s+.*writeFile)`,
    String.raw`\b` + PROVIDER_CLI_NAME + String.raw`\s+mcp\s+`,
  ].join('|'),
  'i',
);
const BASH_REDIRECT_PATTERN = /(^|[^<])>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/;
const BASH_REDIRECT_GLOBAL_PATTERN =
  /(^|[^<])>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;
const BASH_DD_OF_PATTERN = /\bof=("[^"]+"|'[^']+'|[^\s;&|]+)/i;
const BASH_DD_OF_GLOBAL_PATTERN = /\bof=("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
const BASH_OUTPUT_OPTION_PATTERN =
  /\b(?:--output|-o)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/i;
const BASH_OUTPUT_OPTION_GLOBAL_PATTERN =
  /\b(?:--output|-o)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
const GH_TEXT_PAYLOAD_COMMAND_PATTERN =
  /\bgh\s+(?:issue|pr)\s+(?:create|edit|comment)\b/i;
const GH_TEXT_PAYLOAD_FILE_OPTIONS = new Set([
  '--body-file',
  '--template',
  '-F',
]);
const PROVIDER_MCP_MUTATION_PATTERN = new RegExp(
  `\\b${PROVIDER_CLI_NAME}\\s+mcp\\s+(add|add-json|remove|reset-project-choices|reset)\\b`,
  'i',
);
const GH_TOKEN_PATTERN = /"[^"]*"|'[^']*'|`[^`]*`|\$\([^)]*\)|[^\s]+/g;

export function commandText(input: unknown): string | undefined {
  return stringField(input, 'command') ?? stringField(input, 'cmd');
}

export function isProviderMcpMutationCommand(command: string): boolean {
  return PROVIDER_MCP_MUTATION_PATTERN.test(command);
}

export function hasBashMutationVerb(command: string): boolean {
  return BASH_MUTATION_VERB_PATTERN.test(command);
}

export function hasBashRedirect(command: string): boolean {
  return BASH_REDIRECT_PATTERN.test(command);
}

export function inferBashTarget(command: string): string | undefined {
  if (PROVIDER_MCP_MUTATION_PATTERN.test(command)) return 'provider-mcp-config';
  const redirectTarget = inferBashRedirectTarget(command);
  if (redirectTarget && isCleanPathlikeTarget(redirectTarget)) {
    return redirectTarget;
  }
  const ddOutputTarget = inferBashDdOutputTarget(command);
  if (ddOutputTarget && isCleanPathlikeTarget(ddOutputTarget)) {
    return ddOutputTarget;
  }
  const outputOptionTarget = inferBashOutputOptionTarget(command);
  if (outputOptionTarget && isCleanPathlikeTarget(outputOptionTarget)) {
    return outputOptionTarget;
  }
  return (
    redirectTarget ??
    ddOutputTarget ??
    outputOptionTarget ??
    firstProtectedPathMention(command)
  );
}

export function inferBashMutationTargets(command: string): string[] {
  return [
    ...allMatches(command, BASH_REDIRECT_GLOBAL_PATTERN, 2),
    ...allMatches(command, BASH_DD_OF_GLOBAL_PATTERN, 1),
    ...allMatches(command, BASH_OUTPUT_OPTION_GLOBAL_PATTERN, 1),
  ].map(unquote);
}

export function isSafeProtectedPathTextPayloadCommand(
  command: string,
): boolean {
  if (!GH_TEXT_PAYLOAD_COMMAND_PATTERN.test(command)) return false;
  return (
    !/[;&|]/.test(command) &&
    !/[\r\n]/.test(command) &&
    !BASH_REDIRECT_PATTERN.test(command) &&
    !BASH_DD_OF_PATTERN.test(command) &&
    !BASH_MUTATION_VERB_PATTERN.test(command) &&
    !hasProtectedPathInGhTextPayloadCommand(command)
  );
}

export function hasProtectedPathInGhTextPayloadCommand(
  command: string,
): boolean {
  if (!GH_TEXT_PAYLOAD_COMMAND_PATTERN.test(command)) return false;
  return (
    hasProtectedPathPayloadArgument(command) ||
    hasProtectedPathCommandSubstitution(command) ||
    hasProtectedPathPositionalArgument(command)
  );
}

function inferBashRedirectTarget(command: string): string | undefined {
  const match = BASH_REDIRECT_PATTERN.exec(command);
  if (!match) return undefined;
  return unquote(match[2]);
}

function inferBashDdOutputTarget(command: string): string | undefined {
  const match = BASH_DD_OF_PATTERN.exec(command);
  if (!match) return undefined;
  return unquote(match[1]);
}

function inferBashOutputOptionTarget(command: string): string | undefined {
  const match = BASH_OUTPUT_OPTION_PATTERN.exec(command);
  if (!match) return undefined;
  return unquote(match[1]);
}

function allMatches(command: string, pattern: RegExp, group: number): string[] {
  pattern.lastIndex = 0;
  const matches = [...command.matchAll(pattern)].flatMap((match) =>
    match[group] ? [match[group]] : [],
  );
  pattern.lastIndex = 0;
  return matches;
}

function stringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function isCleanPathlikeTarget(target: string): boolean {
  return (
    !/[(){}<>`]/.test(target) &&
    !/^\$[\w{]/.test(target) &&
    !target.includes('$(')
  );
}

function hasProtectedPathPayloadArgument(command: string): boolean {
  const tokens = command.match(GH_TOKEN_PATTERN);
  if (!tokens) return false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === 'gh') {
      index += 2;
      continue;
    }
    const option = splitOptionToken(token);
    if (!option) continue;
    if (!GH_TEXT_PAYLOAD_FILE_OPTIONS.has(option.name)) continue;
    const value = option.value ?? tokens[index + 1];
    if (!value) continue;
    const unquotedValue = unquote(value);
    if (hasProtectedPathReference(unquotedValue)) {
      return true;
    }
    if (option.value === undefined) index += 1;
  }
  return false;
}

function hasProtectedPathPositionalArgument(command: string): boolean {
  const tokens = command.match(GH_TOKEN_PATTERN);
  if (!tokens || tokens.length < 4) return false;
  let positionalIndex = 0;

  for (let index = 3; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith('-')) {
      const option = splitOptionToken(token);
      if (!option) continue;
      if (
        option.value === undefined &&
        ghOptionConsumesNextToken(option.name)
      ) {
        index += 1;
      }
      continue;
    }
    positionalIndex += 1;
    if (positionalIndex !== 1) continue;
    const value = unquote(token);
    if (hasProtectedPathReference(value)) {
      return true;
    }
  }
  return false;
}

function hasProtectedPathCommandSubstitution(command: string): boolean {
  const substitutions = command.match(/\$\([^)]*\)|`[^`]*`/g);
  if (!substitutions) return false;
  return substitutions.some((value) => {
    const text = value.startsWith('$(')
      ? value.slice(2, -1)
      : value.slice(1, -1);
    return hasProtectedPathReference(text);
  });
}

function splitOptionToken(
  token: string,
): { name: string; value?: string } | undefined {
  if (!token.startsWith('-')) return undefined;
  const separatorIndex = token.indexOf('=');
  return separatorIndex <= 0
    ? { name: token }
    : {
        name: token.slice(0, separatorIndex),
        value: token.slice(separatorIndex + 1),
      };
}

function ghOptionConsumesNextToken(optionName: string): boolean {
  return (
    ['--body', '--title', '--field'].includes(optionName) ||
    GH_TEXT_PAYLOAD_FILE_OPTIONS.has(optionName)
  );
}
