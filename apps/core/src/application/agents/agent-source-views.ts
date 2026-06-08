import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { AgentSkillBinding } from '../../domain/skills/skills.js';
import type { AgentToolSource } from '../../domain/tools/tools.js';

export interface ReadableSkillSource {
  name?: string;
  id: string;
}

export interface ReadableToolSource {
  id: string;
  kind: string;
  version?: string;
}

export async function readableSkillSources(input: {
  skillBindings: readonly AgentSkillBinding[];
  repository: SkillCatalogRepository;
}): Promise<ReadableSkillSource[]> {
  const activeBindings = input.skillBindings.filter(
    (binding) => binding.status === 'active',
  );
  const skills = await Promise.all(
    activeBindings.map((binding) => input.repository.getSkill(binding.skillId)),
  );
  return activeBindings.map((binding, index) => {
    const skill = skills[index];
    return {
      ...(skill ? { name: skill.name } : {}),
      id: String(binding.skillId),
    };
  });
}

export function readableToolSources(
  sources: readonly AgentToolSource[],
): ReadableToolSource[] {
  return sources
    .filter((source) => source.status === 'active')
    .map((source) => ({
      id: source.sourceId,
      kind: source.kind,
      ...(source.version && source.version !== source.kind
        ? { version: source.version }
        : {}),
    }));
}
