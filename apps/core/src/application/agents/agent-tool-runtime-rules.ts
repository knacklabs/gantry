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
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import type { CapabilityRuntimeAccess } from '../../shared/capability-runtime-access.js';

export interface AgentToolRuntimeRuleResolutionInput {
  repository: ToolCatalogRepository;
  appId: string;
  agentId: string;
  errorSubject: string;
  skillRepository?: SkillCatalogRepository;
  makeError?: (message: string) => Error;
}

export interface AgentToolRuntimePolicy {
  rules: string[];
  runtimeAccess: CapabilityRuntimeAccess[];
}

export async function resolveAgentToolRuntimeRules(
  input: AgentToolRuntimeRuleResolutionInput,
): Promise<string[]> {
  return (await resolveAgentToolRuntimePolicy(input)).rules;
}

export async function resolveAgentToolRuntimePolicy(
  input: AgentToolRuntimeRuleResolutionInput,
): Promise<AgentToolRuntimePolicy> {
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
  const runtimeAccess: CapabilityRuntimeAccess[] = [];
  const rules = tools.flatMap((tool) => {
    if (tool?.appId && tool.appId !== input.appId) return [];
    const name = tool?.name?.trim();
    const capability = semanticCapabilityFromToolCatalogItem({
      name,
      inputSchema: tool?.inputSchema,
    });
    if (name && parseSemanticCapabilityRule(name) && !capability) {
      throw input.makeError
        ? input.makeError(
            `${input.errorSubject} ${name} is invalid. Semantic capability rules must resolve to a reviewed capability definition.`,
          )
        : new Error(
            `${input.errorSubject} ${name} is invalid. Semantic capability rules must resolve to a reviewed capability definition.`,
          );
    }
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
    if (capability) {
      runtimeAccess.push(...projectCapabilityRuntimeAccess(capability));
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
  return {
    rules,
    runtimeAccess,
  };
}

function projectCapabilityRuntimeAccess(
  capability: SemanticCapabilityDefinition,
): CapabilityRuntimeAccess[] {
  const source = skillActionSource(capability);
  const common = {
    selectedCapabilityId: capability.capabilityId,
    auditLabel: capability.displayName || capability.capabilityId,
  };
  const commandRules = commandRulesFromCapability(capability);
  if (source) {
    const hosts = normalizedHosts(capability.networkHosts);
    return [
      {
        ...common,
        sourceType: 'skill_action',
        skillId: source.skillId,
        selectedAction: source.actionId,
        declaredEnvRefs: stringList(capability.redactionPolicy?.env),
        commandRules,
        networkBindings:
          commandRules.length > 0 ? [{ commandRules, hosts }] : [],
      },
    ];
  }
  const access: CapabilityRuntimeAccess[] = [];
  const localCliCommandRules = localCliCommandRulesFromCapability(capability);
  if (
    capability.credentialSource === 'local_cli' &&
    localCliCommandRules.length > 0
  ) {
    const hosts = normalizedHosts(capability.networkHosts);
    access.push({
      ...common,
      sourceType: 'local_cli',
      commandRules: localCliCommandRules,
      credentialDirs: credentialDirectoryHintsFromProtectedPaths(
        capability.protectedPaths,
      ),
      networkBindings:
        localCliCommandRules.length > 0
          ? [{ commandRules: localCliCommandRules, hosts }]
          : [],
    });
  }
  for (const binding of capability.implementationBindings) {
    if (binding.kind === 'adapter' && binding.adapterRef?.trim()) {
      access.push({
        ...common,
        sourceType: 'configured_adapter',
        adapterRef: binding.adapterRef.trim(),
      });
      continue;
    }
    if (binding.kind === 'mcp_tool' && binding.mcpTool?.trim()) {
      access.push({
        ...common,
        sourceType: 'mcp_server',
        reviewedServerId: mcpServerIdFromTool(binding.mcpTool) ?? 'unknown',
        allowedTools: [binding.mcpTool.trim()],
        credentialRefs: [],
        networkHosts: [],
      });
      continue;
    }
    if (binding.kind === 'tool_rule' && binding.rule?.trim()) {
      access.push({
        ...common,
        sourceType: 'builtin_tool',
        runtimeToolRules: [binding.rule.trim()],
      });
    }
  }
  return access;
}

function commandRulesFromCapability(
  capability: SemanticCapabilityDefinition,
): string[] {
  const out = new Set<string>();
  for (const binding of capability.implementationBindings) {
    if (binding.kind === 'tool_rule' && binding.rule?.trim()) {
      out.add(binding.rule.trim());
    }
    if (binding.kind === 'local_cli') {
      if (capability.credentialSource !== 'local_cli') continue;
      for (const rule of commandRulesFromTemplates(binding.commandTemplates)) {
        out.add(rule);
      }
    }
  }
  return [...out];
}

function localCliCommandRulesFromCapability(
  capability: SemanticCapabilityDefinition,
): string[] {
  const out = new Set<string>();
  for (const binding of capability.implementationBindings) {
    if (capability.credentialSource !== 'local_cli') continue;
    if (binding.kind !== 'local_cli') continue;
    for (const rule of commandRulesFromTemplates(binding.commandTemplates)) {
      out.add(rule);
    }
  }
  return [...out];
}

function commandRulesFromTemplates(
  templates: readonly string[] | undefined,
): string[] {
  return stringList(templates).map((template) => `RunCommand(${template})`);
}

function normalizedHosts(values: readonly string[] | undefined): string[] {
  return stringList(values).map((host) => host.toLowerCase());
}

function credentialDirectoryHintsFromProtectedPaths(
  values: readonly string[] | undefined,
): string[] {
  const out = new Set<string>();
  for (const value of stringList(values)) {
    const directory = credentialDirectoryHintFromProtectedPath(value);
    if (directory) out.add(directory);
  }
  return [...out];
}

function credentialDirectoryHintFromProtectedPath(
  protectedPath: string,
): string | undefined {
  let value = protectedPath.trim();
  while (pathHintLeaf(value)?.includes('*')) {
    const parent = parentPathHint(value);
    if (!parent) return undefined;
    value = parent;
  }
  value = stripTrailingPathSeparator(value);
  if (!value || value.includes('*')) return undefined;
  const leaf = pathHintLeaf(value);
  if (!leaf) return undefined;
  if (looksLikeFilePathHint(leaf)) {
    return parentPathHint(value);
  }
  return value;
}

function stripTrailingPathSeparator(value: string): string {
  return value.replace(/[/\\]+$/, '');
}

function pathHintLeaf(value: string): string | undefined {
  return value.split(/[/\\]/).filter(Boolean).pop();
}

function looksLikeFilePathHint(leaf: string): boolean {
  if (leaf.startsWith('.')) return false;
  return /^[^/\\]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(leaf);
}

function parentPathHint(value: string): string | undefined {
  const separatorIndex = Math.max(
    value.lastIndexOf('/'),
    value.lastIndexOf('\\'),
  );
  if (separatorIndex === 0 && value.startsWith('/')) return '/';
  if (separatorIndex <= 0) return undefined;
  const parent = stripTrailingPathSeparator(value.slice(0, separatorIndex));
  return parent || undefined;
}

function stringList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out];
}

function mcpServerIdFromTool(toolName: string): string | undefined {
  const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName.trim());
  return match?.[1];
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
    skills.flatMap((skill) =>
      (skill.actionPermissions ?? []).map((action) =>
        skillActionProjectionKey({
          skillId: String(skill.id),
          actionId: action.id,
        }),
      ),
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
      actionId: source.actionId,
    }),
  );
}

function skillActionProjectionKey(input: {
  skillId: string;
  actionId: string;
}): string {
  return `${input.skillId}\0${input.actionId}`;
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
