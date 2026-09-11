import type { McpServerDefinition } from '../../domain/mcp/mcp-servers.js';
import type { SkillCatalogItem } from '../../domain/skills/skills.js';
import type { ToolCatalogItem } from '../../domain/tools/tools.js';
import { isSkillUsableForBinding } from '../../domain/skills/skills.js';
import { isGantryFacadeExactToolName } from '../../shared/agent-tool-references.js';
import { isDurableGantryMcpToolFullName } from '../../shared/admin-mcp-tools.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import {
  localCliArgPatterns,
  semanticCapabilityFromToolCatalogItem,
  type SemanticCapabilityImplementationBinding,
  type SemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import { humanizeTechnicalIdentifier } from '../../shared/user-visible-messages.js';

// Tool-source-agnostic by design: built-in connectors (for example Google or
// Microsoft) project as reviewed_capability entries instead of adding a
// provider-specific catalog kind.
export type CatalogEntryKind =
  | 'reviewed_capability'
  | 'requestable_tool'
  | 'skill'
  | 'mcp_source';

export type CatalogInvocation =
  | {
      kind: 'local_cli';
      toolRef: 'capability_run';
      capabilityId: string;
      argumentPatterns: string[];
    }
  | {
      kind: 'mcp_pattern';
      toolRef: 'mcp_call_tool';
      serverName: string;
      toolPatterns: string[];
    }
  | { kind: 'tool_rule'; toolName: string }
  | { kind: 'adapter'; toolName?: string };

export interface CatalogEntry {
  kind: CatalogEntryKind;
  stableRef: string;
  revision?: string;
  displayName: string;
  description: string;
  category: string;
  accountLabel?: string;
  invocations?: CatalogInvocation[];
}

export interface AgentPromptCapabilityCatalog {
  schemaVersion: 1;
  readyActions: CatalogEntry[];
  requestableActions?: CatalogEntry[];
  installedSkills: CatalogEntry[];
  connectedMcpSources: CatalogEntry[];
  digest: string;
}

const DISPLAY_NAME_LIMIT = 96;
const DESCRIPTION_LIMIT = 160;
const CATEGORY_LIMIT = 64;
const ACCOUNT_LABEL_LIMIT = 96;

export function resolveAgentPromptCapabilityCatalog(input: {
  appId: string;
  agentId: string;
  readySemanticCapabilities?: readonly SemanticCapabilityDefinition[];
  requestableSemanticCapabilities?: readonly SemanticCapabilityDefinition[];
  requestableTools?: readonly ToolCatalogItem[];
  readyToolRules?: readonly string[];
  installedSkills?: readonly SkillCatalogItem[];
  connectedMcpSources?: readonly McpServerDefinition[];
}): AgentPromptCapabilityCatalog {
  const readyActions = resolveReadyActions(input.readySemanticCapabilities);
  const requestableActions = resolveRequestableActions(input);
  const installedSkills = projectInstalledSkills(
    input.appId,
    input.agentId,
    input.installedSkills ?? [],
  );
  const connectedMcpSources = projectConnectedMcpSources(
    input.appId,
    input.connectedMcpSources ?? [],
  );
  const projection = {
    schemaVersion: 1 as const,
    readyActions: sortEntries(readyActions),
    requestableActions: sortEntries(requestableActions),
    installedSkills: sortEntries(installedSkills),
    connectedMcpSources: sortEntries(connectedMcpSources),
  };
  return { ...projection, digest: stableSha256Json(projection) };
}

function resolveRequestableActions(input: {
  readySemanticCapabilities?: readonly SemanticCapabilityDefinition[];
  requestableSemanticCapabilities?: readonly SemanticCapabilityDefinition[];
  requestableTools?: readonly ToolCatalogItem[];
  readyToolRules?: readonly string[];
}): CatalogEntry[] {
  const readyCapabilityIds = new Set(
    (input.readySemanticCapabilities ?? []).map(
      (capability) => capability.capabilityId,
    ),
  );
  const capabilities = resolveReadyActions(
    (input.requestableSemanticCapabilities ?? []).filter(
      (capability) => !readyCapabilityIds.has(capability.capabilityId),
    ),
  );
  const readyToolRules = new Set(input.readyToolRules ?? []);
  const directTools = (input.requestableTools ?? []).flatMap(
    (tool): CatalogEntry[] => {
      if (!tool.selectable || hasSemanticCapability(tool)) return [];
      const identity = requestableToolIdentity(tool.name);
      if (!identity || readyToolRules.has(identity)) return [];
      return [
        {
          kind: 'requestable_tool',
          stableRef: identity,
          revision: String(tool.updatedAt),
          displayName: normalizedText(
            tool.displayName,
            humanizeTechnicalIdentifier(identity),
            DISPLAY_NAME_LIMIT,
          ),
          description: normalizedText(
            tool.description,
            'Reviewed Gantry action available after approval.',
            DESCRIPTION_LIMIT,
          ),
          category: normalizedText(tool.category, 'actions', CATEGORY_LIMIT),
        },
      ];
    },
  );
  return dedupeEntries([...capabilities, ...directTools]);
}

function hasSemanticCapability(tool: ToolCatalogItem): boolean {
  return Boolean(semanticCapabilityFromToolCatalogItem(tool));
}

function requestableToolIdentity(name: string): string | undefined {
  const value = name.trim();
  return isGantryFacadeExactToolName(value) ||
    isDurableGantryMcpToolFullName(value)
    ? value
    : undefined;
}

function resolveReadyActions(
  capabilities: readonly SemanticCapabilityDefinition[] | undefined,
): CatalogEntry[] {
  const actions = (capabilities ?? []).flatMap((capability): CatalogEntry[] => {
    if (
      capability.implementationBindings.some(
        (binding) => binding.kind === 'mcp_tool',
      )
    ) {
      throw new Error(
        `Capability ${capability.capabilityId} uses the unsupported legacy mcp_tool binding.`,
      );
    }
    const revision = normalizedRevision(capability.version);
    const accountLabel = normalizedOptional(
      capability.accountLabel,
      ACCOUNT_LABEL_LIMIT,
    );
    const invocations = capability.implementationBindings
      .flatMap((binding) => projectInvocation(capability, binding))
      .sort(compareInvocations);
    return [
      {
        kind: 'reviewed_capability',
        stableRef: capability.capabilityId,
        ...(revision ? { revision } : {}),
        displayName: normalizedText(
          capability.displayName,
          humanizeTechnicalIdentifier(capability.capabilityId),
          DISPLAY_NAME_LIMIT,
        ),
        description: normalizedText(
          capability.can,
          'Reviewed action available to this agent.',
          DESCRIPTION_LIMIT,
        ),
        category: normalizedText(
          capability.category,
          'actions',
          CATEGORY_LIMIT,
        ),
        ...(accountLabel ? { accountLabel } : {}),
        ...(invocations.length > 0 ? { invocations } : {}),
      },
    ];
  });
  const uniqueActions = dedupeEntries(actions);
  const nameCounts = new Map<string, number>();
  for (const action of uniqueActions) {
    const key = action.displayName.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  return uniqueActions.map((action) =>
    nameCounts.get(action.displayName.toLowerCase()) === 1
      ? withoutAccountLabel(action)
      : action,
  );
}

function projectInvocation(
  capability: SemanticCapabilityDefinition,
  binding: SemanticCapabilityImplementationBinding,
): CatalogInvocation[] {
  switch (binding.kind) {
    case 'local_cli':
      return [
        {
          kind: 'local_cli',
          toolRef: 'capability_run',
          capabilityId: capability.capabilityId,
          argumentPatterns: localCliArgPatterns({
            implementationBindings: [binding],
          }),
        },
      ];
    case 'mcp_pattern':
      return binding.mcpServer?.trim() && binding.mcpToolPatterns?.length
        ? [
            {
              kind: 'mcp_pattern',
              toolRef: 'mcp_call_tool',
              serverName: binding.mcpServer.trim(),
              toolPatterns: [...binding.mcpToolPatterns],
            },
          ]
        : [];
    case 'tool_rule':
      return binding.rule?.trim()
        ? [{ kind: 'tool_rule', toolName: binding.rule.trim() }]
        : [];
    case 'adapter': {
      const adapterRef = binding.adapterRef?.trim();
      return adapterRef?.startsWith('builtin:') && adapterRef.length > 8
        ? [{ kind: 'adapter', toolName: adapterRef.slice(8) }]
        : [{ kind: 'adapter' }];
    }
    case 'mcp_tool':
      return [];
  }
}

const INVOCATION_KIND_ORDER: Record<CatalogInvocation['kind'], number> = {
  local_cli: 0,
  mcp_pattern: 1,
  tool_rule: 2,
  adapter: 3,
};

function compareInvocations(
  left: CatalogInvocation,
  right: CatalogInvocation,
): number {
  return (
    INVOCATION_KIND_ORDER[left.kind] - INVOCATION_KIND_ORDER[right.kind] ||
    compareText(JSON.stringify(left), JSON.stringify(right))
  );
}

function projectInstalledSkills(
  appId: string,
  agentId: string,
  skills: readonly (SkillCatalogItem | null)[],
): CatalogEntry[] {
  return dedupeEntries(
    skills.flatMap((skill): CatalogEntry[] => {
      if (
        !skill ||
        skill.appId !== appId ||
        (skill.agentId && skill.agentId !== agentId) ||
        !isSkillUsableForBinding(skill)
      ) {
        return [];
      }
      const revision = normalizedRevision(
        skill.storage?.contentHash ?? skill.updatedAt,
      );
      return [
        {
          kind: 'skill',
          stableRef: String(skill.id),
          ...(revision ? { revision } : {}),
          displayName: normalizedText(
            skill.name,
            humanizeTechnicalIdentifier(String(skill.id)),
            DISPLAY_NAME_LIMIT,
          ),
          description: normalizedText(
            skill.description,
            'Installed skill instructions.',
            DESCRIPTION_LIMIT,
          ),
          category: 'skills',
        },
      ];
    }),
  );
}

function projectConnectedMcpSources(
  appId: string,
  servers: readonly (McpServerDefinition | null)[],
): CatalogEntry[] {
  return dedupeEntries(
    servers.flatMap((server): CatalogEntry[] => {
      if (!server || server.appId !== appId || server.status !== 'active') {
        return [];
      }
      const revision = normalizedRevision(server.updatedAt);
      return [
        {
          kind: 'mcp_source',
          stableRef: String(server.id),
          ...(revision ? { revision } : {}),
          displayName: normalizedText(
            server.displayName ?? server.name,
            humanizeTechnicalIdentifier(server.name),
            DISPLAY_NAME_LIMIT,
          ),
          description: normalizedText(
            server.description,
            'Connected MCP source inventory.',
            DESCRIPTION_LIMIT,
          ),
          category: 'mcp',
        },
      ];
    }),
  );
}

function normalizedText(
  value: string | undefined,
  fallback: string,
  limit: number,
): string {
  return boundOneLine(value) || boundOneLine(fallback).slice(0, limit);

  function boundOneLine(candidate: string | undefined): string {
    const normalized = candidate?.replace(/\s+/g, ' ').trim() ?? '';
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
  }
}

function normalizedOptional(
  value: string | undefined,
  limit = DESCRIPTION_LIMIT,
): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizedRevision(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function withoutAccountLabel(entry: CatalogEntry): CatalogEntry {
  const { accountLabel: _accountLabel, ...rest } = entry;
  return rest;
}

function dedupeEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [
    ...new Map(entries.map((entry) => [entry.stableRef, entry])).values(),
  ];
}

function sortEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort(compareCatalogEntries);
}

export function compareCatalogEntries(
  left: CatalogEntry,
  right: CatalogEntry,
): number {
  for (const [leftValue, rightValue] of [
    [left.category, right.category],
    [left.displayName, right.displayName],
    [left.stableRef, right.stableRef],
  ]) {
    const order = compareText(leftValue, rightValue);
    if (order !== 0) return order;
  }
  return 0;
}

function compareText(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft < normalizedRight
    ? -1
    : normalizedLeft > normalizedRight
      ? 1
      : left < right
        ? -1
        : left > right
          ? 1
          : 0;
}
