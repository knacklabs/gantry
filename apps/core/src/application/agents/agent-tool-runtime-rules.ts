import type { ToolCatalogRepository } from '../../domain/ports/repositories.js';
import { isMyClawMcpWildcardRule } from '../../shared/admin-mcp-tools.js';
import {
  BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  isBrowserActionMcpToolRule,
  isProjectedBrowserMcpToolRule,
  isThirdPartyMcpToolRule,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import { projectToolCatalogItemToRuntimeRules } from '../../shared/semantic-capabilities.js';

export interface AgentToolRuntimeRuleResolutionInput {
  repository: ToolCatalogRepository;
  appId: string;
  agentId: string;
  errorSubject: string;
  makeError?: (message: string) => Error;
}

export async function resolveAgentToolRuntimeRules(
  input: AgentToolRuntimeRuleResolutionInput,
): Promise<string[]> {
  const bindings = await input.repository.listAgentToolBindings({
    appId: input.appId as never,
    agentId: input.agentId as never,
  });
  const activeBindings = bindings.filter(
    (binding) => binding.status === 'active',
  );
  const tools = await Promise.all(
    activeBindings.map((binding) => input.repository.getTool(binding.toolId)),
  );
  const rules = tools.flatMap((tool) => {
    if (tool?.appId && tool.appId !== input.appId) return [];
    const name = tool?.name?.trim();
    return name
      ? projectToolCatalogItemToRuntimeRules({
          name,
          inputSchema: tool?.inputSchema,
        })
      : [];
  });
  validateAgentToolRuntimeRules({
    rules,
    errorSubject: input.errorSubject,
    makeError: input.makeError,
  });
  return rules;
}

export function validateAgentToolRuntimeRules(input: {
  rules: readonly string[];
  errorSubject: string;
  makeError?: (message: string) => Error;
}): void {
  const fail = (rule: string, reason: string): never => {
    const message = `${input.errorSubject} ${rule} is invalid. ${reason}`;
    throw input.makeError ? input.makeError(message) : new Error(message);
  };
  const staleBrowserRule = input.rules.find(isBrowserActionMcpToolRule);
  if (staleBrowserRule) {
    fail(staleBrowserRule, BROWSER_ACTION_MCP_RULE_REJECTION_REASON);
  }
  const projectedBrowserRule = input.rules.find(isProjectedBrowserMcpToolRule);
  if (projectedBrowserRule) {
    fail(projectedBrowserRule, BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON);
  }
  const myclawWildcardRule = input.rules.find(isMyClawMcpWildcardRule);
  if (myclawWildcardRule) {
    fail(
      myclawWildcardRule,
      'Persistent MyClaw MCP wildcard grants are not supported; request one exact mcp__myclaw__ tool.',
    );
  }
  const thirdPartyMcpToolRule = input.rules.find(isThirdPartyMcpToolRule);
  if (thirdPartyMcpToolRule) {
    fail(
      thirdPartyMcpToolRule,
      'Third-party MCP tool names are not selected directly; request and bind the MCP server capability.',
    );
  }
  for (const rule of input.rules) {
    const validation = validateReadableAgentToolRule(rule);
    if (!validation.ok) {
      fail(rule, validation.reason);
    }
  }
}
