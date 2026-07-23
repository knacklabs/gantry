import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
} from '../../domain/ports/repositories.js';
import { isSkillUsableForBinding } from '../../domain/skills/skills.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import { humanizeTechnicalIdentifier } from '../../shared/user-visible-messages.js';

// Tool-source-agnostic by design: built-in connectors (for example Google or
// Microsoft) project as reviewed_capability entries instead of adding a
// provider-specific catalog kind.
export type CatalogEntryKind = 'reviewed_capability' | 'skill' | 'mcp_source';

export interface CatalogEntry {
  kind: CatalogEntryKind;
  stableRef: string;
  revision?: string;
  displayName: string;
  description: string;
  category: string;
  accountLabel?: string;
}

export interface AgentPromptCapabilityCatalog {
  schemaVersion: 1;
  readyActions: CatalogEntry[];
  installedSkills: CatalogEntry[];
  connectedMcpSources: CatalogEntry[];
  digest: string;
}

type RepositoryInput<T> = T | (() => T | undefined);

const DISPLAY_NAME_LIMIT = 96;
const DESCRIPTION_LIMIT = 160;
const CATEGORY_LIMIT = 64;
const ACCOUNT_LABEL_LIMIT = 96;

export async function resolveAgentPromptCapabilityCatalog(input: {
  appId: string;
  agentId: string;
  readySemanticCapabilities?: readonly SemanticCapabilityDefinition[];
  skillRepository?: RepositoryInput<SkillCatalogRepository>;
  mcpServerRepository?: RepositoryInput<McpServerRepository>;
}): Promise<AgentPromptCapabilityCatalog> {
  const skillRepository = repositoryValue(input.skillRepository);
  const mcpServerRepository = repositoryValue(input.mcpServerRepository);
  const [readyActions, installedSkills, connectedMcpSources] =
    await Promise.all([
      resolveReadyActions(input.readySemanticCapabilities),
      resolveInstalledSkills(input, skillRepository),
      resolveConnectedMcpSources(input, mcpServerRepository),
    ]);
  const projection = {
    schemaVersion: 1 as const,
    readyActions: sortEntries(readyActions),
    installedSkills: sortEntries(installedSkills),
    connectedMcpSources: sortEntries(connectedMcpSources),
  };
  return { ...projection, digest: stableSha256Json(projection) };
}

function resolveReadyActions(
  capabilities: readonly SemanticCapabilityDefinition[] | undefined,
): CatalogEntry[] {
  const actions = (capabilities ?? []).map((capability): CatalogEntry => {
    const revision = normalizedRevision(capability.version);
    const accountLabel = normalizedOptional(
      capability.accountLabel,
      ACCOUNT_LABEL_LIMIT,
    );
    return {
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
      category: normalizedText(capability.category, 'actions', CATEGORY_LIMIT),
      ...(accountLabel ? { accountLabel } : {}),
    };
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

async function resolveInstalledSkills(
  input: { appId: string; agentId: string },
  repository: SkillCatalogRepository | undefined,
): Promise<CatalogEntry[]> {
  if (!repository) return [];
  const bindings = await repository.listAgentSkillBindings({
    appId: input.appId as AppId,
    agentId: input.agentId as AgentId,
  });
  const skills = await Promise.all(
    bindings
      .filter(
        (binding) =>
          binding.status === 'active' &&
          binding.appId === input.appId &&
          binding.agentId === input.agentId,
      )
      .map((binding) => repository.getSkill(binding.skillId)),
  );
  return dedupeEntries(
    skills.flatMap((skill): CatalogEntry[] => {
      if (
        !skill ||
        skill.appId !== input.appId ||
        (skill.agentId && skill.agentId !== input.agentId) ||
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

async function resolveConnectedMcpSources(
  input: { appId: string; agentId: string },
  repository: McpServerRepository | undefined,
): Promise<CatalogEntry[]> {
  if (!repository) return [];
  const bindings = await repository.listAgentBindings({
    appId: input.appId as AppId,
    agentId: input.agentId as AgentId,
    limit: 500,
  });
  const servers = await Promise.all(
    bindings
      .filter(
        (binding) =>
          binding.status === 'active' &&
          binding.appId === input.appId &&
          binding.agentId === input.agentId,
      )
      .map((binding) => repository.getServer(binding.serverId)),
  );
  return dedupeEntries(
    servers.flatMap((server): CatalogEntry[] => {
      if (
        !server ||
        server.appId !== input.appId ||
        server.status !== 'active'
      ) {
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

function repositoryValue<T>(
  input: RepositoryInput<T> | undefined,
): T | undefined {
  return typeof input === 'function' ? (input as () => T | undefined)() : input;
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
