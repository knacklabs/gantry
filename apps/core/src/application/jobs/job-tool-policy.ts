import type { Job } from '../../domain/types.js';
import type { ToolCatalogRepository } from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import {
  anyToolRuleMatches,
  normalizeToolRules,
  validateAutonomousToolRules,
} from '../../shared/tool-rule-matcher.js';
import {
  ADMIN_MCP_TOOL_FULL_NAMES,
  isMyClawMcpWildcardRule,
} from '../../shared/admin-mcp-tools.js';

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
    (rule) => !anyToolRuleMatches(input.inheritedTools, rule),
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
  return bindings
    .filter((binding) => binding.status === 'active')
    .map((binding) => {
      const value = String(binding.toolId);
      return value.startsWith('tool:') ? value.slice('tool:'.length) : value;
    });
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
