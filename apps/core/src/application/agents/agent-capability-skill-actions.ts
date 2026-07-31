import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
} from '../../domain/skills/skills.js';
import { isSkillUsableForBinding } from '../../domain/skills/skills.js';
import { skillActionSemanticCapabilitiesForSkills } from '../../domain/skills/skill-action-permissions.js';
import type { ToolCatalogItem } from '../../domain/tools/tools.js';
import { isAdminMcpToolFullName } from '../../shared/admin-mcp-tools.js';
import { isGantryFacadeExactToolRule } from '../../shared/agent-tool-references.js';
import { validateDurableAccessRule } from '../../shared/durable-access-policy.js';
import { canonicalizeDurableSkillActionToolRule } from '../../shared/skill-action-capability-rules.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import {
  semanticCapabilityFromToolCatalogItem,
  type SemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import { ApplicationError } from '../common/application-error.js';

export async function skillActionDefinitionsForAgent(input: {
  appId: AppId;
  agentId: AgentId;
  skillRepository: SkillCatalogRepository;
}): Promise<Record<string, SemanticCapabilityDefinition>> {
  const skillBindings = await input.skillRepository.listAgentSkillBindings({
    appId: input.appId,
    agentId: input.agentId,
  });
  return skillActionDefinitionsForBindings({
    appId: input.appId,
    skillBindings,
    skillRepository: input.skillRepository,
  });
}

export async function skillActionDefinitionsForBindings(input: {
  appId: AppId;
  skillBindings: readonly AgentSkillBinding[];
  skillRepository: SkillCatalogRepository;
}): Promise<Record<string, SemanticCapabilityDefinition>> {
  const activeSkillIds = [
    ...new Set(
      input.skillBindings
        .filter((binding) => binding.status === 'active')
        .map((binding) => binding.skillId),
    ),
  ];
  const skills = (
    await Promise.all(
      activeSkillIds.map((skillId) => input.skillRepository.getSkill(skillId)),
    )
  ).filter(
    (skill): skill is SkillCatalogItem =>
      !!skill && skill.appId === input.appId && isSkillUsableForBinding(skill),
  );
  return skillActionSemanticCapabilitiesForSkills(skills);
}

export async function catalogSemanticCapabilityDefinitions(input: {
  appId: AppId;
  toolRepository: ToolCatalogRepository;
}): Promise<Record<string, SemanticCapabilityDefinition>> {
  const definitions: Record<string, SemanticCapabilityDefinition> = {};
  for (const tool of await input.toolRepository.listTools({
    appId: input.appId,
    statuses: ['active'],
  })) {
    const capability = semanticCapabilityFromToolCatalogItem({
      name: tool.name,
      inputSchema: tool.inputSchema,
    });
    if (capability) definitions[capability.capabilityId] = capability;
  }
  return definitions;
}

export function canonicalToolReferenceForView(
  reference: string,
  options: {
    semanticCapabilityDefinitions?: Record<
      string,
      SemanticCapabilityDefinition
    >;
  } = {},
): string[] {
  const canonical = canonicalizeDurableSkillActionToolRule(reference, {
    semanticCapabilityDefinitions: options.semanticCapabilityDefinitions,
    dropGeneratedWithoutMatch: true,
  });
  return canonical ? [canonical] : [];
}

export function capabilityFromCanonicalToolReference(
  reference: string,
  tool: ToolCatalogItem | undefined,
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>,
): Array<{ id: string; version: string }> {
  const canonical = canonicalToolReferenceForView(reference, {
    semanticCapabilityDefinitions,
  })[0];
  if (!canonical) return [];
  return [
    toolReferenceToCapability(canonical, tool, semanticCapabilityDefinitions),
  ];
}

export function buildSelectedCapabilities(
  configuredToolEntries: Array<{ reference: string; tool: ToolCatalogItem }>,
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>,
): Array<{ id: string; version: string }> {
  return configuredToolEntries.flatMap((entry) =>
    capabilityFromCanonicalToolReference(
      entry.reference,
      entry.tool,
      semanticCapabilityDefinitions,
    ),
  );
}

export function resolveSelectedToolReferences(
  capabilities: ReadonlyArray<{ id: string; version: string }>,
  semanticCapabilityDefinitions: Record<string, SemanticCapabilityDefinition>,
): string[] {
  return [
    ...new Set(
      capabilities.flatMap((capability) => {
        const reference = capabilitySelectionToToolReference(capability.id);
        const validation = validateDurableAccessRule(reference, {
          semanticCapabilityDefinitions,
        });
        if (!validation.ok) {
          throw new ApplicationError('INVALID_REQUEST', validation.reason);
        }
        const canonical = canonicalToolReferenceForView(reference, {
          semanticCapabilityDefinitions,
        });
        if (canonical.length === 0) {
          throw new ApplicationError(
            'INVALID_REQUEST',
            `Capability selection ${capability.id} is not a durable access rule.`,
          );
        }
        return canonical;
      }),
    ),
  ];
}

function capabilitySelectionToToolReference(capabilityId: string): string {
  const id = capabilityId.trim();
  if (id === 'browser.use') return 'Browser';
  if (id.startsWith('RunCommand(')) return id;
  if (isAdminMcpToolFullName(id) || isGantryFacadeExactToolRule(id)) return id;
  return `capability:${id}`;
}

function toolReferenceToCapability(
  reference: string,
  tool?: ToolCatalogItem,
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>,
): { id: string; version: string } {
  if (reference === 'Browser') return { id: 'browser.use', version: 'builtin' };
  if (reference.startsWith('capability:')) {
    const capabilityId = parseSemanticCapabilityRule(reference);
    const semanticCapability = tool
      ? semanticCapabilityFromToolCatalogItem({
          name: tool.name,
          inputSchema: tool.inputSchema,
        })
      : undefined;
    return {
      id: reference.slice('capability:'.length),
      version:
        semanticCapability?.version ??
        (capabilityId
          ? semanticCapabilityDefinitions?.[capabilityId]?.version
          : undefined) ??
        'catalog',
    };
  }
  return { id: reference, version: 'builtin' };
}
