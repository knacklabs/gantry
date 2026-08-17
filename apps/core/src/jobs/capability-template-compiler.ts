import { parseBashCommand } from '../shared/bash-command-parser.js';
import { validateLocalCliCommandTemplate } from '../shared/semantic-capabilities.js';
import { localCliCommandTemplateMatchesArgv } from '../shared/tool-rule-matcher.js';

export type CapabilityTemplateCompilation =
  | { kind: 'covered' }
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
  const parsedTemplates = input.commandTemplates.flatMap((template) => {
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
    return [{ template, tokens }];
  });

  if (
    parsedTemplates.some(({ template }) =>
      localCliCommandTemplateMatchesArgv({
        executablePath: input.executablePath,
        template,
        argv: observedArgv,
      }),
    )
  ) {
    return { kind: 'covered' };
  }

  const candidates = parsedTemplates.flatMap(({ tokens }) => {
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
  if (prefixMatches === 0) return { kind: 'instruction', prefixMatches };
  const proposalSets = candidates.map((candidate) =>
    compileCandidate({
      executablePath: input.executablePath,
      candidate,
      observedArgv,
    }),
  );
  if (proposalSets.some((templates) => templates === null)) {
    return { kind: 'instruction', prefixMatches };
  }
  const canonicalProposalSets = proposalSets.map((templates) =>
    canonicalTemplateSet(templates!),
  );
  const proposedTemplates = canonicalProposalSets[0]!;
  if (
    canonicalProposalSets.some(
      (templates) => !templateSetsEqual(proposedTemplates, templates),
    )
  ) {
    return { kind: 'instruction', prefixMatches };
  }
  return { kind: 'proposal', prefixMatches, proposedTemplates, observedArgv };
}

function compileCandidate(input: {
  executablePath: string;
  candidate: { tokens: string[] };
  observedArgv: readonly string[];
}): string[] | null {
  const { candidate, observedArgv } = input;
  if (candidate.tokens.some((token) => token.includes('*') && token !== '*')) {
    return null;
  }
  for (let cursor = 0; cursor < candidate.tokens.length; cursor += 1) {
    const pattern = candidate.tokens[cursor]!;
    const value = observedArgv[cursor];
    if (pattern === '*') {
      // A terminal wildcard is the reviewed remainder and would have matched
      // in the shared coverage check. Non-terminal wildcards consume exactly
      // one non-flag argv entry; they are never optional compiler slots.
      if (
        cursor === candidate.tokens.length - 1 ||
        value === undefined ||
        value.startsWith('-')
      ) {
        return null;
      }
    } else if (value === undefined || pattern !== value) return null;
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
    // Bare --name / -x flags only (letters, digits, '-', '_'). Inline
    // values (--account=owner@host) would persist the value inside the
    // literal flag token, bypassing argv redaction - conservative
    // fallback.
    if (
      !/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ||
      !value ||
      value.startsWith('-')
    ) {
      return null;
    }
    flags.push({ name, value });
    index += 2;
  }
  if (positional.length === 0 && flags.length === 0) {
    return null;
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
    return null;
  }
  return proposedTemplates;
}

function canonicalTemplateSet(templates: readonly string[]): string[] {
  return [...new Set(templates.map((template) => template.trim()))].sort();
}

function templateSetsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((template, index) => template === right[index])
  );
}

function shellQuoteToken(token: string): string {
  if (token === '*' || /^[A-Za-z0-9@%+=:,./*_-]+$/.test(token)) return token;
  return `'${token.replaceAll("'", `'\\''`)}'`;
}
