import type { AgentInput } from './agent-spawn-types.js';
import { validateAgentToolRuntimeRules } from '../application/agents/agent-tool-runtime-rules.js';
import { isThirdPartyMcpToolRule } from '../shared/agent-tool-references.js';

function hasReviewedMcpRuntimeAccessForRule(
  input: AgentInput,
  rule: string,
): boolean {
  const trimmed = rule.trim();
  return (input.runtimeAccess ?? []).some(
    (access) =>
      access.sourceType === 'mcp_server' &&
      access.allowedTools.includes(trimmed),
  );
}

export function validateRunnerAllowedTools(input: AgentInput): string | null {
  const rules = input.allowedTools ?? [];
  const projectedThirdPartyMcpRules = rules.filter(isThirdPartyMcpToolRule);
  const allowProjectedThirdPartyMcpTools =
    projectedThirdPartyMcpRules.length > 0 &&
    projectedThirdPartyMcpRules.every((rule) =>
      hasReviewedMcpRuntimeAccessForRule(input, rule),
    );
  try {
    validateAgentToolRuntimeRules({
      rules,
      errorSubject: 'Configured agent tool',
      allowProjectedThirdPartyMcpTools,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
