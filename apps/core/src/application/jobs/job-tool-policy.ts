import type { Job } from '../../domain/types.js';
import type { ToolCatalogRepository } from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import {
  anyToolRuleMatches,
  normalizeToolRules,
  toolRuleCoversRule,
  validateAutonomousToolRules,
} from '../../shared/tool-rule-matcher.js';
import {
  ADMIN_MCP_TOOL_FULL_NAMES,
  isMyClawMcpWildcardRule,
} from '../../shared/admin-mcp-tools.js';
import {
  BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  isBrowserActionMcpToolRule,
  isProjectedBrowserMcpToolRule,
} from '../../shared/agent-tool-references.js';

const ADMIN_TOOLS = new Set<string>(ADMIN_MCP_TOOL_FULL_NAMES);

export interface JobToolPolicyResolution {
  inheritedTools: string[];
  jobExtraTools: string[];
  effectiveAllowedTools: string[];
}

export function normalizeJobExtraTools(input: unknown): string[] {
  const rules = normalizeToolRules(Array.isArray(input) ? input : undefined);
  const validation = validateAutonomousToolRules(rules);
  if (!validation.ok) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      validation.reason || 'Invalid job tool rule.',
    );
  }
  return rules;
}

export function assertJobExtraToolsAllowedForTarget(input: {
  rules: readonly string[];
  inheritedTools: readonly string[];
}): void {
  const inheritedBrowserActionRule = input.inheritedTools.find((rule) =>
    isBrowserActionMcpToolRule(rule),
  );
  if (inheritedBrowserActionRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Inherited agent tool ${inheritedBrowserActionRule} is invalid. ${BROWSER_ACTION_MCP_RULE_REJECTION_REASON}`,
    );
  }
  const inheritedProjectedBrowserRule = input.inheritedTools.find(
    isProjectedBrowserMcpToolRule,
  );
  if (inheritedProjectedBrowserRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Inherited agent tool ${inheritedProjectedBrowserRule} is invalid. ${BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON}`,
    );
  }
  const browserActionRule = input.rules.find((rule) =>
    isBrowserActionMcpToolRule(rule),
  );
  if (browserActionRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Tool ${browserActionRule} is a browser action MCP tool and cannot be added as a job-scoped extra. Request persistent Browser capability first with request_permission temporaryOnly=false, then use the projected browser_* tools.`,
    );
  }
  const projectedBrowserRule = input.rules.find(isProjectedBrowserMcpToolRule);
  if (projectedBrowserRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Tool ${projectedBrowserRule} is a runtime projection and cannot be added as a job-scoped extra. ${BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON}`,
    );
  }
  const forbidden = input.rules.find(
    (rule) =>
      isMyClawMcpWildcardRule(rule) ||
      (ADMIN_TOOLS.has(rule) &&
        !anyToolRuleMatches(input.inheritedTools, rule)),
  );
  if (forbidden) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Tool ${forbidden} requires a selected agent capability before it can be used by an autonomous job.`,
    );
  }
}

export function agentIdForJobGroupScope(groupScope: string): string {
  const trimmed = groupScope.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

export function jobToolRulesBeyondInherited(input: {
  requestedRules: readonly string[];
  inheritedTools: readonly string[];
}): string[] {
  return input.requestedRules.filter(
    (rule) =>
      !input.inheritedTools.some((inheritedRule) =>
        toolRuleCoversRule(inheritedRule, rule),
      ),
  );
}

export async function resolveJobToolPolicy(input: {
  job: Job;
  appId?: string;
  agentId?: string;
  toolRepository?: ToolCatalogRepository;
}): Promise<JobToolPolicyResolution> {
  const inheritedTools =
    input.appId && input.agentId
      ? await resolveAgentToolBindings({
          repository: input.toolRepository,
          appId: input.appId,
          agentId: input.agentId,
        })
      : [];
  const jobExtraTools = normalizeJobExtraTools(
    input.job.capability_policy?.allowed_tools,
  );
  assertJobExtraToolsAllowedForTarget({
    rules: jobExtraTools,
    inheritedTools,
  });
  return {
    inheritedTools,
    jobExtraTools,
    effectiveAllowedTools: mergeUnique(inheritedTools, jobExtraTools),
  };
}

export async function resolveAgentToolBindings(input: {
  repository?: ToolCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<string[]> {
  if (!input.repository) return [];
  const bindings = await input.repository.listAgentToolBindings({
    appId: input.appId as never,
    agentId: input.agentId as never,
  });
  const activeBindings = bindings.filter(
    (binding) => binding.status === 'active',
  );
  const tools = await Promise.all(
    activeBindings.map((binding) => input.repository?.getTool(binding.toolId)),
  );
  const rules = tools.flatMap((tool) => {
    if (tool?.appId && tool.appId !== input.appId) return [];
    const name = tool?.name?.trim();
    return name ? [name] : [];
  });
  const staleBrowserRule = rules.find(isBrowserActionMcpToolRule);
  if (staleBrowserRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Inherited agent tool ${staleBrowserRule} is invalid. ${BROWSER_ACTION_MCP_RULE_REJECTION_REASON}`,
    );
  }
  const projectedBrowserRule = rules.find(isProjectedBrowserMcpToolRule);
  if (projectedBrowserRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Inherited agent tool ${projectedBrowserRule} is invalid. ${BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON}`,
    );
  }
  return rules;
}

function mergeUnique(
  base: readonly string[],
  next: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const item of [...base, ...next]) {
    const value = item.trim();
    if (value) out.add(value);
  }
  return [...out];
}
