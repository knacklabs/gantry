import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type { AgentSkillBinding } from '../../domain/skills/skills.js';
import type { AgentToolBinding } from '../../domain/tools/tools.js';
import {
  emptyPermissionRules,
  hasPermissionRules,
  normalizePermissionRules,
} from '../../shared/permission-rules.js';
import type { RuntimeConfiguredAgentCapabilities } from './runtime-settings-types.js';

export function hasAnyConfiguredCapability(
  capabilities: RuntimeConfiguredAgentCapabilities,
): boolean {
  return (
    capabilities.toolIds.length > 0 ||
    capabilities.skillIds.length > 0 ||
    capabilities.mcpServerIds.length > 0
  );
}

export function hasConfiguredPermissionRules(
  capabilities: RuntimeConfiguredAgentCapabilities,
): boolean {
  return hasPermissionRules(capabilities.permissionRules);
}

export function activeConfiguredCapabilities(
  toolBindings: AgentToolBinding[],
  skillBindings: AgentSkillBinding[],
  mcpBindings: AgentMcpServerBinding[],
  permissionRules: Array<{ effect: 'allow' | 'deny'; rule: string }>,
): RuntimeConfiguredAgentCapabilities {
  return {
    toolIds: toolBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.toolId),
    skillIds: skillBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.skillId),
    mcpServerIds: mcpBindings
      .filter((binding) => binding.status === 'active')
      .map((binding) => binding.serverId),
    permissionRules: normalizePermissionRules({
      allow: permissionRules
        .filter((rule) => rule.effect === 'allow')
        .map((rule) => rule.rule),
      deny: permissionRules
        .filter((rule) => rule.effect === 'deny')
        .map((rule) => rule.rule),
    }),
  };
}

export function flattenPermissionRules(
  rules: RuntimeConfiguredAgentCapabilities['permissionRules'] | undefined,
): Array<{ effect: 'allow' | 'deny'; rule: string }> {
  const normalized = normalizePermissionRules(rules ?? emptyPermissionRules());
  return [
    ...normalized.allow.map((rule) => ({ effect: 'allow' as const, rule })),
    ...normalized.deny.map((rule) => ({ effect: 'deny' as const, rule })),
  ];
}
