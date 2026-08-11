import type { AppId } from '../../domain/app/app.js';
import { skillActionSource } from '../../domain/skills/skill-action-permissions.js';
import type {
  AgentToolBinding,
  ToolCatalogItem,
  ToolId,
} from '../../domain/tools/tools.js';
import {
  adminMcpToolIdForFullName,
  isAdminMcpToolFullName,
} from '../../shared/admin-mcp-tools.js';
import {
  displayToolReference,
  isCanonicalBrowserCapabilityRule,
  parseReadableScopedToolRule,
  persistentPermissionToolId,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import {
  durableAccessRuleAuditPreview,
  validateDurableAccessRule,
} from '../../shared/durable-access-policy.js';
import { canonicalizeDurableSkillActionToolRule } from '../../shared/skill-action-capability-rules.js';
import {
  expandSemanticCapabilityPermissionRules,
  sameMcpCapabilityProposalAuthority,
  semanticCapabilityRuntimeRules,
  semanticCapabilityFromToolCatalogItem,
  type SemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { stableSha256Json } from '../../shared/stable-hash.js';

export function validatePersistentRule(
  allowedRule: string,
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
  } = {},
): void {
  const validation = validateDurableAccessRule(allowedRule, {
    ...options,
    allowUnknownSemanticCapability: false,
  });
  if (!validation.ok) throw new Error(validation.reason);
  const adminMcpTool = adminMcpToolFullNameFromRule(allowedRule);
  if (adminMcpTool && adminMcpTool !== allowedRule) {
    throw new Error(
      'Persistent Gantry admin MCP tool grants must request the exact tool name without a scoped rule.',
    );
  }
}

export function canonicalPersistentPermissionRules(
  rules: readonly string[],
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>,
): string[] {
  return [
    ...new Set(
      rules.flatMap((rule) => {
        const canonical = canonicalizeDurableSkillActionToolRule(rule, {
          semanticCapabilityDefinitions,
          dropGeneratedWithoutMatch: true,
        });
        return canonical ? [canonical] : [];
      }),
    ),
  ];
}

export function semanticCapabilityDefinitionsFromToolCatalog(
  tools: readonly ToolCatalogItem[],
): Record<string, SemanticCapabilityDefinition> | undefined {
  const definitions: Record<string, SemanticCapabilityDefinition> = {};
  for (const tool of tools) {
    if (tool.status !== 'active' || !tool.selectable) continue;
    const capability = semanticCapabilityFromToolCatalogItem({
      name: tool.name,
      inputSchema: tool.inputSchema,
    });
    if (!capability) continue;
    definitions[capability.capabilityId] = capability;
  }
  return Object.keys(definitions).length > 0 ? definitions : undefined;
}

export function assertNoRequestCapabilityDefinitionConflicts(input: {
  catalogDefinitions?: Record<string, SemanticCapabilityDefinition>;
  requestDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): void {
  for (const [capabilityId, requestDefinition] of Object.entries(
    input.requestDefinitions ?? {},
  )) {
    const catalogDefinition = input.catalogDefinitions?.[capabilityId];
    if (!catalogDefinition) continue;
    if (
      stableSha256Json(catalogDefinition) ===
      stableSha256Json(requestDefinition)
    ) {
      continue;
    }
    if (
      sameMcpCapabilityProposalAuthority(catalogDefinition, requestDefinition)
    ) {
      continue;
    }
    throw new Error(
      `Semantic capability ${capabilityId} does not match the active catalog definition.`,
    );
  }
}

export function mergeSemanticCapabilityDefinitions(
  requestDefinitions?: Record<string, SemanticCapabilityDefinition>,
  catalogDefinitions?: Record<string, SemanticCapabilityDefinition>,
): Record<string, SemanticCapabilityDefinition> | undefined {
  const merged = {
    ...(requestDefinitions ?? {}),
    ...(catalogDefinitions ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function persistentPermissionRuleAuditPreviewForRules(
  rules: readonly string[],
): string {
  if (rules.length === 0) return 'unknown';
  if (rules.length === 1 && rules[0]) {
    return durableAccessRuleAuditPreview(rules[0]);
  }
  return rules.map(durableAccessRuleAuditPreview).join(', ');
}

export function persistentPermissionGrantAuditMetadata(input: {
  rules: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): Record<string, unknown> {
  const skillActions = input.rules
    .map((rule) => {
      const capabilityId = parseSemanticCapabilityRule(rule);
      if (!capabilityId) return undefined;
      const capability = input.semanticCapabilityDefinitions?.[capabilityId];
      if (!capability) return undefined;
      const source = skillActionSource(capability);
      if (!source) return undefined;
      return {
        capabilityId,
        displayName: capability.displayName,
        skillId: source.skillId,
        skillName: source.skillName,
        actionId: source.actionId,
        commandPreviewHashes: semanticCapabilityRuntimeRules(capability).map(
          (runtimeRule) => `sha256:${stableSha256Json({ runtimeRule })}`,
        ),
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
  return skillActions.length > 0
    ? { capabilitySource: 'skill_action', skillActions }
    : {};
}

export function adminMcpToolFullNameFromRule(
  allowedRule: string,
): string | null {
  const trimmed = allowedRule.trim();
  const scoped = parseReadableScopedToolRule(trimmed);
  const toolName = scoped ? scoped.toolName : trimmed;
  return isAdminMcpToolFullName(toolName) ? toolName : null;
}

// Shared grants use the same canonical id every binding importer computes
// (`agent-tool-binding:<agentId>:<toolId>`), so the permission writer and the
// settings-import writer upsert ONE row instead of colliding on the unique
// (agent, tool, config_version, person) tuple. Person-scoped grants append the
// personId; they are DB-only and never round-trip through settings.
export function persistentPermissionBindingId(
  agentId: string,
  toolId: string,
  personId?: string | null,
): AgentToolBinding['id'] {
  const base = `agent-tool-binding:${agentId}:${toolId}`;
  return (personId ? `${base}:${personId}` : base) as AgentToolBinding['id'];
}

export function resolveRevocationTarget(input: {
  appId: AppId;
  bindings: readonly AgentToolBinding[];
  toolById: ReadonlyMap<ToolId, ToolCatalogItem>;
  toolName?: string;
  toolId?: string;
}): {
  binding: AgentToolBinding;
  rule: string;
  tool: ToolCatalogItem | undefined;
} {
  const requestedToolId = input.toolId?.trim();
  const requestedToolName = input.toolName?.trim();
  if (!requestedToolId && !requestedToolName) {
    throw new Error('admin_permission_revoke requires tool_id or tool_name.');
  }
  let binding: AgentToolBinding | undefined;
  if (requestedToolId) {
    binding = input.bindings.find(
      (candidate) => candidate.toolId === requestedToolId,
    );
  }
  if (!binding && requestedToolName) {
    const candidateIds = candidateToolIdsForRule(
      input.appId,
      requestedToolName,
    );
    binding = input.bindings.find((candidate) => {
      if (candidateIds.has(candidate.toolId)) return true;
      const tool = input.toolById.get(candidate.toolId);
      return (
        tool?.name?.trim() === requestedToolName ||
        displayToolReference({ toolId: candidate.toolId, tool }) ===
          requestedToolName
      );
    });
  }
  if (!binding) {
    throw new Error(
      `No active current-agent tool grant matches ${requestedToolId ?? requestedToolName}.`,
    );
  }
  const tool = input.toolById.get(binding.toolId);
  const rule = displayToolReference({ toolId: binding.toolId, tool });
  const validation = validateReadableAgentToolRule(rule);
  if (!validation.ok) {
    throw new Error(
      `Cannot revoke unreadable tool grant ${binding.toolId}: ${validation.reason}`,
    );
  }
  return { binding, rule, tool };
}

export function expandedRevocationLiveRules(input: {
  rule: string;
  tool?: ToolCatalogItem;
}): string[] {
  const capability = input.tool
    ? semanticCapabilityFromToolCatalogItem({
        name: input.tool.name ?? input.rule,
        inputSchema: input.tool.inputSchema,
      })
    : undefined;
  return expandSemanticCapabilityPermissionRules({
    rules: [input.rule],
    definitions: capability
      ? { [capability.capabilityId]: capability }
      : undefined,
  });
}

function candidateToolIdsForRule(appId: AppId, rule: string): Set<ToolId> {
  const out = new Set<ToolId>();
  if (isCanonicalBrowserCapabilityRule(rule)) out.add('tool:Browser' as ToolId);
  if (isAdminMcpToolFullName(rule)) {
    out.add(adminMcpToolIdForFullName(rule) as ToolId);
  }
  const semanticCapabilityId = parseSemanticCapabilityRule(rule);
  if (semanticCapabilityId) {
    out.add(`tool:capability:${semanticCapabilityId}` as ToolId);
  }
  out.add(persistentPermissionToolId(appId, rule) as ToolId);
  return out;
}
