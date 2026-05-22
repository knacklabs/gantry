import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import { skillActionSource } from '../../domain/skills/skill-action-permissions.js';
import { isGantryMcpWildcardRule } from '../../shared/admin-mcp-tools.js';
import {
  BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  isBrowserActionMcpToolRule,
  isProjectedBrowserMcpToolRule,
  isThirdPartyMcpToolRule,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import {
  projectToolCatalogItemToRuntimeRules,
  semanticCapabilityFromToolCatalogItem,
  type SemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';

export interface AgentToolRuntimeRuleResolutionInput {
  repository: ToolCatalogRepository;
  appId: string;
  agentId: string;
  errorSubject: string;
  skillRepository?: SkillCatalogRepository;
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
  const activeSkillActionKeys = await activeSkillActionProjectionKeys(input);
  const rules = tools.flatMap((tool) => {
    if (tool?.appId && tool.appId !== input.appId) return [];
    const name = tool?.name?.trim();
    const capability = semanticCapabilityFromToolCatalogItem({
      name,
      inputSchema: tool?.inputSchema,
    });
    if (name && isThirdPartyMcpToolRule(name) && !capability) {
      throw input.makeError
        ? input.makeError(
            `${input.errorSubject} ${name} is invalid. Third-party MCP tools must be projected from a reviewed semantic capability.`,
          )
        : new Error(
            `${input.errorSubject} ${name} is invalid. Third-party MCP tools must be projected from a reviewed semantic capability.`,
          );
    }
    if (
      capability &&
      !canProjectSemanticCapability(capability, activeSkillActionKeys)
    ) {
      return [];
    }
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
    allowProjectedThirdPartyMcpTools: true,
    makeError: input.makeError,
  });
  return rules;
}

async function activeSkillActionProjectionKeys(
  input: AgentToolRuntimeRuleResolutionInput,
): Promise<Set<string> | undefined> {
  if (!input.skillRepository) return undefined;
  if (!('listEnabledSkillsForAgent' in input.skillRepository)) {
    return undefined;
  }
  const skills = await input.skillRepository.listEnabledSkillsForAgent({
    appId: input.appId as never,
    agentId: input.agentId as never,
  });
  return new Set(
    skills
      .filter((skill) => skill.storage?.contentHash)
      .map((skill) =>
        skillActionProjectionKey({
          skillId: String(skill.id),
          contentHash: skill.storage!.contentHash,
        }),
      ),
  );
}

function canProjectSemanticCapability(
  capability: SemanticCapabilityDefinition,
  activeSkillActionKeys: Set<string> | undefined,
): boolean {
  const source = skillActionSource(capability);
  if (!source) return true;
  if (!activeSkillActionKeys) return false;
  return activeSkillActionKeys.has(
    skillActionProjectionKey({
      skillId: source.skillId,
      contentHash: source.skillContentHash,
    }),
  );
}

function skillActionProjectionKey(input: {
  skillId: string;
  contentHash: string;
}): string {
  return `${input.skillId}\0${input.contentHash}`;
}

export function validateAgentToolRuntimeRules(input: {
  rules: readonly string[];
  errorSubject: string;
  allowProjectedThirdPartyMcpTools?: boolean;
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
  const gantryWildcardRule = input.rules.find(isGantryMcpWildcardRule);
  if (gantryWildcardRule) {
    fail(
      gantryWildcardRule,
      'Persistent Gantry MCP wildcard grants are not supported; request one exact mcp__gantry__ tool.',
    );
  }
  const thirdPartyMcpToolRule = input.rules.find(isThirdPartyMcpToolRule);
  if (thirdPartyMcpToolRule && !input.allowProjectedThirdPartyMcpTools) {
    fail(
      thirdPartyMcpToolRule,
      'Third-party MCP tool names must be projected from a reviewed semantic capability.',
    );
  }
  for (const rule of input.rules) {
    const validation = validateReadableAgentToolRule(rule);
    if (!validation.ok) {
      fail(rule, validation.reason);
    }
  }
}
