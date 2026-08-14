import { parseBashCommand } from '../shared/bash-command-parser.js';
import { validateLocalCliCommandTemplate } from '../shared/semantic-capabilities.js';

export type CapabilityTemplateCompilation =
  | { kind: 'instruction'; prefixMatches: number }
  | {
      kind: 'proposal';
      prefixMatches: number;
      proposedTemplates: string[];
      observedArgv: string[];
    };

export function compileCapabilityTemplateMismatch(input: {
  executablePath: string;
  commandTemplates: readonly string[];
  observedArgs: readonly string[];
}): CapabilityTemplateCompilation {
  const observedArgv = [input.executablePath, ...input.observedArgs];
  const candidates = input.commandTemplates.flatMap((template) => {
    const validation = validateLocalCliCommandTemplate(
      input.executablePath,
      template,
    );
    if (!validation.ok) return [];
    const parsed = parseBashCommand(template.trim());
    if (
      !parsed.ok ||
      parsed.leaves.length !== 1 ||
      parsed.leaves[0]!.redirects.length > 0
    ) {
      return [];
    }
    const tokens = parsed.leaves[0]!.argv;
    const firstNonLiteral = tokens.findIndex(
      (token, index) =>
        index > 0 && (token.includes('*') || token.startsWith('-')),
    );
    const literalPrefix =
      firstNonLiteral === -1 ? tokens : tokens.slice(0, firstNonLiteral);
    if (
      literalPrefix.length < 2 ||
      !literalPrefix.every((token, index) => observedArgv[index] === token)
    ) {
      return [];
    }
    return [{ tokens }];
  });

  const prefixMatches = candidates.length;
  if (prefixMatches !== 1) return { kind: 'instruction', prefixMatches };
  const candidate = candidates[0]!;
  if (candidate.tokens.some((token) => token.includes('*') && token !== '*')) {
    return { kind: 'instruction', prefixMatches };
  }
  if (observedArgv.length < candidate.tokens.length) {
    return { kind: 'instruction', prefixMatches };
  }
  for (let index = 0; index < candidate.tokens.length; index += 1) {
    const pattern = candidate.tokens[index]!;
    const value = observedArgv[index]!;
    if (pattern === '*') {
      if (value.startsWith('-')) return { kind: 'instruction', prefixMatches };
    } else if (pattern !== value) {
      return { kind: 'instruction', prefixMatches };
    }
  }

  const trailing = observedArgv.slice(candidate.tokens.length);
  const positional: string[] = [];
  const flags: Array<{ name: string; value: string }> = [];
  let index = 0;
  while (index < trailing.length && !trailing[index]!.startsWith('-')) {
    positional.push(trailing[index]!);
    index += 1;
  }
  while (index < trailing.length) {
    const name = trailing[index]!;
    const value = trailing[index + 1];
    // Strict flag grammar: bare --name / -x only. Inline values
    // (--account=owner@host) would persist the value inside the literal
    // flag token, bypassing argv redaction - conservative fallback.
    if (
      !/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(name) ||
      !value ||
      value.startsWith('-')
    ) {
      return { kind: 'instruction', prefixMatches };
    }
    flags.push({ name, value });
    index += 2;
  }
  if (positional.length === 0 && flags.length === 0) {
    return { kind: 'instruction', prefixMatches };
  }

  // Tokens were DECODED by the parser; a bare join would silently merge a
  // quoted literal like 'named range' into two tokens and authorize a
  // different shape. Serialize every literal with safe shell quoting.
  const baseTokens = [
    ...candidate.tokens.map(shellQuoteToken),
    ...positional.map(() => '*'),
  ];
  const proposedTemplates = [baseTokens.join(' ')];
  if (flags.length > 0) {
    proposedTemplates.push(
      [...baseTokens, ...flags.flatMap((flag) => [flag.name, '*'])].join(' '),
    );
  }
  if (
    proposedTemplates.some(
      (template) =>
        !validateLocalCliCommandTemplate(input.executablePath, template).ok,
    )
  ) {
    return { kind: 'instruction', prefixMatches };
  }
  return { kind: 'proposal', prefixMatches, proposedTemplates, observedArgv };
}

function shellQuoteToken(token: string): string {
  if (token === '*' || /^[A-Za-z0-9@%+=:,./*_-]+$/.test(token)) return token;
  return `'${token.replaceAll("'", `'\\''`)}'`;
}
