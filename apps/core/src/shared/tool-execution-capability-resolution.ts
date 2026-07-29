import {
  semanticCapabilityRuntimeRules,
  type SemanticCapabilityDefinition,
} from './semantic-capabilities.js';
import { parseSemanticCapabilityRule } from './semantic-capability-ids.js';

// Process-lifetime dedup so an unresolved capability rule logs once, not on
// every evaluation. ponytail: module-level set; a per-process warn is enough
// diagnostics without spamming — no eviction needed for a bounded id space.
const loggedUnresolvedCapabilities = new Set<string>();

export interface ResolvedCapabilityRules {
  rules: string[];
  // Concrete runtime rule -> the capability id that authorized it, for reason
  // attribution when a match lands on a capability-derived rule.
  capabilityByRule: Map<string, string>;
}

// A granted `capability:<id>` rule is not itself an executable tool rule; it is
// an alias for the authority its reviewed bundle declares. Resolve each such
// rule to that bundle's concrete rules (source-type-agnostic:
// commandRules/allowedTools/runtimeToolRules all flow through
// semanticCapabilityRuntimeRules). An unresolvable capability rule is dropped
// (skip-unknown) so it never converts an unrelated tool's decision into a deny.
export function resolveCapabilityRules(
  rules: readonly string[],
  definitions: Record<string, SemanticCapabilityDefinition> | undefined,
): ResolvedCapabilityRules {
  const out: string[] = [];
  const seen = new Set<string>();
  const capabilityByRule = new Map<string, string>();
  const add = (rule: string, capabilityId?: string) => {
    const trimmed = rule.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
    if (capabilityId && !capabilityByRule.has(trimmed)) {
      capabilityByRule.set(trimmed, capabilityId);
    }
  };
  for (const rule of rules) {
    const capabilityId = parseSemanticCapabilityRule(rule);
    if (!capabilityId) {
      add(rule);
      continue;
    }
    const definition =
      definitions && Object.hasOwn(definitions, capabilityId)
        ? definitions[capabilityId]
        : undefined;
    if (!definition) {
      if (!loggedUnresolvedCapabilities.has(capabilityId)) {
        loggedUnresolvedCapabilities.add(capabilityId);
        console.warn(
          `[tool-execution-policy] skipping unresolved capability rule capability:${capabilityId} (no reviewed definition available)`,
        );
      }
      continue;
    }
    for (const runtimeRule of semanticCapabilityRuntimeRules(definition)) {
      add(runtimeRule, capabilityId);
    }
  }
  return { rules: out, capabilityByRule };
}
