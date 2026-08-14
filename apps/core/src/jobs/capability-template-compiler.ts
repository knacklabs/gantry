import { parseBashCommand } from '../shared/bash-command-parser.js';
import { validateLocalCliCommandTemplate } from '../shared/semantic-capabilities.js';

export type CapabilityTemplateCompilation =
  | { kind: 'instruction' }
  | {
      kind: 'proposal';
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

  if (candidates.length !== 1) return { kind: 'instruction' };
  const candidate = candidates[0]!;
  if (candidate.tokens.some((token) => token.includes('*') && token !== '*')) {
    return { kind: 'instruction' };
  }
  if (observedArgv.length < candidate.tokens.length) {
    return { kind: 'instruction' };
  }
  for (let index = 0; index < candidate.tokens.length; index += 1) {
    const pattern = candidate.tokens[index]!;
    const value = observedArgv[index]!;
    if (pattern === '*') {
      if (value.startsWith('-')) return { kind: 'instruction' };
    } else if (pattern !== value) {
      return { kind: 'instruction' };
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
      return { kind: 'instruction' };
    }
    flags.push({ name, value });
    index += 2;
  }
  if (positional.length === 0 && flags.length === 0) {
    return { kind: 'instruction' };
  }

  // Tokens were DECODED by the parser; join(' ') would silently merge a
  // quoted literal like 'named range' into two tokens and authorize a
  // different shape. Any token that does not round-trip bare falls to
  // instruction - conservative authority synthesis.
  if (
    candidate.tokens.some((token) => !/^[A-Za-z0-9@%+=:,./*_-]+$/.test(token))
  ) {
    return { kind: 'instruction' };
  }
  const baseTokens = [...candidate.tokens, ...positional.map(() => '*')];
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
    return { kind: 'instruction' };
  }
  return { kind: 'proposal', proposedTemplates, observedArgv };
}
