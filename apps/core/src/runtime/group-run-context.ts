import type { GroupProcessingDeps } from './group-processing-types.js';
import type { ConfiguredAgentToolPolicy } from './configured-agent-tools.js';
import { resolveAgentToolRuntimePolicyFromSnapshot } from '../application/agents/agent-tool-runtime-rules.js';
import type { AgentAccessSnapshot } from '../application/agent-execution/agent-access-snapshot.js';
import type {
  AgentMcpAccessSnapshot,
  AgentSkillAccessSnapshot,
  AgentToolAccessSnapshot,
} from '../domain/ports/repositories.js';
import { authorizedMcpServerIdsFromSnapshot } from '../application/mcp/mcp-authorized-servers.js';
import { skillActionDefinitionsFromSnapshot } from '../application/agents/agent-capability-skill-actions.js';
import { resolveAgentPromptCapabilityCatalog } from '../application/agents/agent-prompt-capability-catalog.js';
import { selectedSkillDisplay } from '../domain/skills/skill-identity.js';
import {
  semanticCapabilityFromToolCatalogItem,
  type SemanticCapabilityDefinition,
} from '../shared/semantic-capabilities.js';

export function memoryScopeForConversationKind(
  conversationKind?: string,
): 'user' | 'group' {
  return conversationKind === 'dm' ? 'user' : 'group';
}

export async function loadAgentAccessSnapshot(
  deps: Pick<
    GroupProcessingDeps,
    'getToolRepository' | 'getSkillRepository' | 'getMcpServerRepository'
  >,
  turnContext?: { appId: string; agentId: string } | null,
): Promise<AgentAccessSnapshot | undefined> {
  if (!turnContext) return undefined;
  const toolRepository = deps.getToolRepository?.();
  const skillRepository = deps.getSkillRepository?.();
  const mcpRepository = deps.getMcpServerRepository?.();
  const [tools, skills, mcp] = await Promise.all([
    toolRepository
      ? toolRepository.listAgentToolAccessSnapshot({
          appId: turnContext.appId as never,
          agentId: turnContext.agentId as never,
        })
      : Promise.resolve({ activeBindings: [], appActiveDefinitions: [] }),
    skillRepository
      ? skillRepository.listAgentSkillAccessSnapshot({
          appId: turnContext.appId as never,
          agentId: turnContext.agentId as never,
        })
      : Promise.resolve({ activeBindings: [], enabledDefinitions: [] }),
    mcpRepository
      ? mcpRepository.listAgentMcpAccessSnapshot({
          appId: turnContext.appId as never,
          agentId: turnContext.agentId as never,
        })
      : Promise.resolve({ activeBindings: [], materializedServers: [] }),
  ]);
  return Object.freeze({
    appId: turnContext.appId,
    agentId: turnContext.agentId,
    tools: freezeToolSurface(tools),
    skills: freezeSkillSurface(skills),
    mcp: freezeMcpSurface(mcp),
  });
}

function freezeToolSurface(
  surface: AgentToolAccessSnapshot,
): AgentToolAccessSnapshot {
  return deepFreeze(surface);
}

function freezeSkillSurface(
  surface: AgentSkillAccessSnapshot,
): AgentSkillAccessSnapshot {
  return deepFreeze(surface);
}

function freezeMcpSurface(
  surface: AgentMcpAccessSnapshot,
): AgentMcpAccessSnapshot {
  return deepFreeze(surface);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreeze(entry))) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const clone: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const [key, entry] of Object.entries(clone)) {
    clone[key] = deepFreeze(entry);
  }
  return Object.freeze(clone) as T;
}

export function resolveTurnToolPolicyFromSnapshot(
  snapshot: AgentAccessSnapshot | undefined,
  personId?: string | null,
): ConfiguredAgentToolPolicy {
  if (!snapshot) {
    return {
      toolPolicyRules: undefined,
      runtimeAccess: [],
      semanticCapabilities: [],
    };
  }
  const policy = resolveAgentToolRuntimePolicyFromSnapshot({
    appId: snapshot.appId,
    errorSubject: 'Configured agent tool',
    selectedToolDefinitionsByBinding: snapshot.tools.activeBindings
      .filter(
        (row) =>
          row.binding.personId == null || row.binding.personId === personId,
      )
      .map((row) => row.definition),
    activeSkillDefinitions: snapshot.skills.enabledDefinitions,
  });
  return {
    toolPolicyRules: policy.rules,
    runtimeAccess: policy.runtimeAccess,
    semanticCapabilities: policy.semanticCapabilities,
  };
}

export function resolveTurnSelectedSkillContextFromSnapshot(
  snapshot: AgentAccessSnapshot | undefined,
): { ids?: string[]; displays?: string[] } {
  if (!snapshot) return {};
  const activeRows = [...snapshot.skills.activeBindings].sort((left, right) =>
    String(left.binding.skillId).localeCompare(String(right.binding.skillId)),
  );
  return {
    ids: activeRows.map((row) => String(row.binding.skillId)),
    displays: activeRows.map((row) =>
      row.definition
        ? selectedSkillDisplay(row.definition)
        : String(row.binding.skillId),
    ),
  };
}

export function resolveTurnSelectedMcpServerIdsFromSnapshot(
  snapshot: AgentAccessSnapshot | undefined,
  routeScope?: { conversationId?: string; threadId?: string },
): string[] | undefined {
  if (!snapshot) return undefined;
  return authorizedMcpServerIdsFromSnapshot({
    appId: snapshot.appId,
    activeRows: snapshot.mcp.activeBindings,
    conversationId: routeScope?.conversationId,
    threadId: routeScope?.threadId,
  });
}

export function resolveTurnPromptCapabilityCatalogFromSnapshot(
  snapshot: AgentAccessSnapshot,
  readySemanticCapabilities: readonly SemanticCapabilityDefinition[],
) {
  return resolveAgentPromptCapabilityCatalog({
    appId: snapshot.appId,
    agentId: snapshot.agentId,
    readySemanticCapabilities,
    installedSkills: snapshot.skills.enabledDefinitions,
    connectedMcpSources: snapshot.mcp.materializedServers.map(
      (row) => row.definition,
    ),
  });
}

export function resolveTurnSemanticCapabilitiesFromSnapshot(
  snapshot: AgentAccessSnapshot | undefined,
): SemanticCapabilityDefinition[] {
  if (!snapshot) return [];
  const byId = new Map<string, SemanticCapabilityDefinition>();
  for (const tool of snapshot.tools.appActiveDefinitions) {
    const capability = semanticCapabilityFromToolCatalogItem(tool);
    if (capability) byId.set(capability.capabilityId, capability);
  }
  const definitions = skillActionDefinitionsFromSnapshot({
    appId: snapshot.appId as never,
    activeRows: snapshot.skills.activeBindings,
  });
  for (const definition of Object.values(definitions)) {
    byId.set(definition.capabilityId, definition);
  }
  return [...byId.values()].sort((left, right) =>
    left.capabilityId.localeCompare(right.capabilityId),
  );
}
