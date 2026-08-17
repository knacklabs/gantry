import { parseBashCommand } from './bash-command-parser.js';

/**
 * Tiered widening classification (decision 0122, amended by Ravi 2026-08-11
 * after the wildcard-as-operation-selector counterexample): the approval
 * card's warning sentence is a non-technical approver's ONLY signal, so
 * nothing is warning-free except an exact-equivalent reshape.
 *
 * - 'equivalent'   — proposed templates are exactly the current set (order/
 *                    dedup-insensitive). No warning.
 * - 'added_inputs' — every proposed template extends a current template only
 *                    by ADDED TRAILING wildcard slots on an identical literal
 *                    prefix. Card carries one soft factual sentence ("takes an
 *                    extra input it couldn't before").
 * - 'expanded'     — anything else: new subcommand, added flag, changed
 *                    literal, different executable, malformed, or unsure.
 *                    Card leads with the stronger plain warning.
 */
export type CapabilityTemplateWideningKind =
  | 'equivalent'
  | 'added_inputs'
  | 'expanded';

function positionalTemplateShape(
  template: string,
): { prefix: string[]; slotCount: number } | null {
  const parsed = parseBashCommand(template.trim());
  if (!parsed.ok || parsed.leaves.length !== 1) return null;
  const leaf = parsed.leaves[0];
  if (!leaf || leaf.redirects.length > 0) return null;
  const firstWildcard = leaf.argv.indexOf('*');
  const prefix =
    firstWildcard === -1 ? leaf.argv : leaf.argv.slice(0, firstWildcard);
  if (
    prefix.length < 2 ||
    prefix.some((token) => token.includes('*')) ||
    prefix.slice(1).some((token) => token.startsWith('-'))
  ) {
    return null;
  }
  if (firstWildcard === -1) {
    return { prefix, slotCount: 0 };
  }
  if (leaf.argv.slice(firstWildcard).some((token) => token !== '*')) {
    return null;
  }
  return {
    prefix,
    slotCount: leaf.argv.length - firstWildcard,
  };
}

function extendsByTrailingInputsOnly(input: {
  currentTemplate: string;
  proposedTemplate: string;
}): boolean {
  const current = positionalTemplateShape(input.currentTemplate);
  const proposed = positionalTemplateShape(input.proposedTemplate);
  if (!current || !proposed) return false;

  if (current.prefix.length !== proposed.prefix.length) return false;
  if (current.prefix.some((token, index) => proposed.prefix[index] !== token)) {
    return false;
  }
  // Under the local-CLI matcher a final `*` is the argv remainder, not one
  // positional slot. Adding the first one therefore grants new authority and
  // must receive the stronger expanded warning.
  if (current.slotCount === 0 && proposed.slotCount > 0) return false;
  return proposed.slotCount >= current.slotCount;
}

function canonicalTemplateSet(templates: readonly string[]): string[] {
  return [...new Set(templates.map((template) => template.trim()))].sort();
}

export function classifyCapabilityTemplateProposal(input: {
  currentTemplates: readonly string[];
  proposedTemplates: readonly string[];
}): CapabilityTemplateWideningKind {
  if (
    input.currentTemplates.length === 0 ||
    input.proposedTemplates.length === 0
  ) {
    return 'expanded';
  }
  const current = canonicalTemplateSet(input.currentTemplates);
  const proposed = canonicalTemplateSet(input.proposedTemplates);
  if (
    current.length === proposed.length &&
    current.every((template, index) => proposed[index] === template)
  ) {
    return 'equivalent';
  }
  // 'added_inputs' requires BOTH directions: every proposed template is a
  // current template or a trailing-slot extension of one, AND every current
  // template survives (kept verbatim or extended). A removal is not an added
  // input — it changes the reviewed shape and takes the stronger warning.
  const everyProposedExtendsByInputs = proposed.every(
    (proposedTemplate) =>
      current.includes(proposedTemplate) ||
      current.some((currentTemplate) =>
        extendsByTrailingInputsOnly({ currentTemplate, proposedTemplate }),
      ),
  );
  const everyCurrentCovered = current.every(
    (currentTemplate) =>
      proposed.includes(currentTemplate) ||
      proposed.some((proposedTemplate) =>
        extendsByTrailingInputsOnly({ currentTemplate, proposedTemplate }),
      ),
  );
  return everyProposedExtendsByInputs && everyCurrentCovered
    ? 'added_inputs'
    : 'expanded';
}

/**
 * Boolean projection for storage/card gating: everything except an
 * exact-equivalent reshape warns (nothing under-warns). Tier selection
 * (soft added-inputs sentence vs strong expanded warning) uses the kind.
 */
export function isCapabilityTemplateProposalWidening(input: {
  currentTemplates: readonly string[];
  proposedTemplates: readonly string[];
}): boolean {
  return classifyCapabilityTemplateProposal(input) !== 'equivalent';
}
