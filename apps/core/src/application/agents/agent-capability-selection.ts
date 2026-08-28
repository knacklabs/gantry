import { ApplicationError } from '../common/application-error.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SkillCatalogItem, SkillId } from '../../domain/skills/skills.js';
import {
  formatSkillMaterializationCollision,
  skillMaterializationCollisions,
} from '../../domain/skills/skill-identity.js';
import type { AgentToolSource } from '../../domain/tools/tools.js';
import {
  isGantryFacadeExactToolRule,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import {
  adminMcpToolNameFromFullName,
  isAdminMcpToolFullName,
} from '../../shared/admin-mcp-tools.js';
import { validateDurableAccessRule } from '../../shared/durable-access-policy.js';
import {
  canonicalToolReferenceForView,
  skillActionDefinitionsForAgent,
} from './agent-capability-skill-actions.js';
import type { ReadableToolSource } from './agent-source-views.js';

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function assertUniqueSkillMaterializationKeys(
  skillIds: readonly SkillId[],
  skills: ReadonlyMap<SkillId, SkillCatalogItem>,
): void {
  const [collision] = skillMaterializationCollisions(
    skillIds.flatMap((skillId) => {
      const skill = skills.get(skillId);
      return skill ? [skill] : [];
    }),
  );
  if (!collision) return;
  throw new ApplicationError(
    'CONFLICT',
    formatSkillMaterializationCollision(collision),
  );
}

function capabilitySelectionToToolReference(capabilityId: string): string {
  const id = capabilityId.trim();
  if (id === 'browser.use') return 'Browser';
  if (id.startsWith('RunCommand(')) return id;
  if (isAdminMcpToolFullName(id) || isGantryFacadeExactToolRule(id)) return id;
  return `capability:${id}`;
}

export function resolveSelectedToolReferences(
  capabilities: ReadonlyArray<{ id: string; version: string }>,
  semanticCapabilityDefinitions: Awaited<
    ReturnType<typeof skillActionDefinitionsForAgent>
  >,
): string[] {
  return unique(
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
  );
}

export function selectedAdminToolNames(tools: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = adminMcpToolNameFromFullName(tool);
    if (name) names.add(name);
  }
  return names;
}

export function uniqueToolSources(
  sources: ReadonlyArray<ReadableToolSource>,
  input: { appId: AppId; agentId: AgentId; now: string },
): AgentToolSource[] {
  const byKey = new Map<string, AgentToolSource>();
  for (const source of sources) {
    const version = source.version ?? source.kind;
    const key = `${source.kind}:${source.id}:${version}`;
    byKey.set(key, {
      id: `agent-tool-source:${input.agentId}:${source.kind}:${source.id}:${version}` as AgentToolSource['id'],
      appId: input.appId,
      agentId: input.agentId,
      sourceId: source.id,
      kind: source.kind as AgentToolSource['kind'],
      version,
      status: 'active',
      createdAt: input.now as never,
      updatedAt: input.now as never,
    });
  }
  return [...byKey.values()];
}
