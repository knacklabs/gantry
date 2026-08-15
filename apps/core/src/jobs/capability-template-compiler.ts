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
    return [{ tokens, prefixLength: literalPrefix.length }];
  });

  const prefixMatches = candidates.length;
  if (prefixMatches !== 1) return { kind: 'instruction', prefixMatches };
  const candidate = candidates[0]!;
  if (candidate.tokens.some((token) => token.includes('*') && token !== '*')) {
    return { kind: 'instruction', prefixMatches };
  }
  // The reviewed template's LEADING positional wildcards — the run of `*`
  // right after the literal subcommand prefix — are a MAXIMUM, not a required
  // count: the observed call may supply FEWER of them and then switch to flags
  // (or simply stop). But a wildcard that is the VALUE of a reviewed literal
  // flag later in the template (for example the `*` in `... --account *`) is
  // NOT optional and stays required. Match literal tokens exactly; end the
  // leading positional run at the first observed flag or the end of the argv,
  // so a flag-form call (for example `--values-json`) is proposed instead of
  // dead-ending on an instruction card. Required literals and required
  // flag-value wildcards still fall to instruction, so neither the pinned
  // subcommand nor an already-reviewed flag's value can be shortened away.
  let cursor = 0;
  let sawTrailingLiteral = false;
  for (; cursor < candidate.tokens.length; cursor += 1) {
    const pattern = candidate.tokens[cursor]!;
    const value = observedArgv[cursor];
    if (pattern === '*') {
      if (sawTrailingLiteral) {
        // Required value of an already-reviewed literal flag.
        if (value === undefined || value.startsWith('-')) {
          return { kind: 'instruction', prefixMatches };
        }
      } else if (value === undefined || value.startsWith('-')) {
        // Leading positional wildcard: optional (trailing positionals are a max).
        break;
      }
    } else if (value === undefined || pattern !== value) {
      return { kind: 'instruction', prefixMatches };
    } else if (cursor >= candidate.prefixLength) {
      // A literal matched AFTER the subcommand prefix is a reviewed flag; every
      // wildcard that follows it is a required flag-value, not an optional
      // trailing positional — even when no positional wildcard preceded it.
      sawTrailingLiteral = true;
    }
  }
  // A break is only legitimate on a positional wildcard: every remaining
  // template token must itself be a positional wildcard, because a template
  // cannot require a literal AFTER the observed call switched to flags.
  if (candidate.tokens.slice(cursor).some((token) => token !== '*')) {
    return { kind: 'instruction', prefixMatches };
  }

  const trailing = observedArgv.slice(cursor);
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
    // Bare --name / -x flags only (letters, digits, '-', '_'). Inline
    // values (--account=owner@host) would persist the value inside the
    // literal flag token, bypassing argv redaction - conservative
    // fallback.
    if (
      !/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ||
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
    ...candidate.tokens.slice(0, cursor).map(shellQuoteToken),
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
